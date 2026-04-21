/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Component, useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
import { 
  Plus, 
  Check, 
  Calendar as CalendarIcon, 
  Users, 
  List, 
  ChevronLeft,
  ChevronRight,
  Settings,
  Star,
  BookOpen,
  Send,
  MessageSquare,
  LogOut,
  LogIn,
  Sparkles,
  Palette,
  Camera,
  Trash2,
  Sun,
  Moon
} from 'lucide-react';
import { 
  format, 
  startOfMonth, 
  endOfMonth, 
  eachDayOfInterval, 
  isSameDay, 
  startOfDay, 
  addMonths, 
  subMonths,
  getDay,
  isAfter
} from 'date-fns';
import { GoogleGenAI } from "@google/genai";
import { cn } from './lib/utils';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged
} from './lib/firebase';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  setDoc,
  getDocFromServer
} from 'firebase/firestore';

// --- Types ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
};

interface Task {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  category?: TaskCategory;
}

interface DiaryEntry {
  id: string;
  date: string; // YYYY-MM-DD
  content: string;
  moodColor?: string;
  chatHistory: { role: 'user' | 'model'; text: string }[];
}

interface DayStats {
  date: string; // YYYY-MM-DD
  completionRate: number; // 0 to 1
}

// --- Constants ---

const MORANDI_COLORS = {
  WORK: { label: '工作', color: '#8E9AAF', bg: 'bg-[#8E9AAF]', border: 'border-[#8E9AAF]/30' },
  HEALTH: { label: '健康', color: '#B1BCA0', bg: 'bg-[#B1BCA0]', border: 'border-[#B1BCA0]/30' },
  PERSONAL: { label: '生活', color: '#D6A290', bg: 'bg-[#D6A290]', border: 'border-[#D6A290]/30' },
  LEARNING: { label: '成长', color: '#E2D1B3', bg: 'bg-[#E2D1B3]', border: 'border-[#E2D1B3]/30' },
} as const;

type TaskCategory = keyof typeof MORANDI_COLORS;

const MOOD_COLORS = [
  { name: '开心', color: '#FFE5B3', description: '明媚的心情' },
  { name: '忧郁', color: '#D1B3FF', description: '静静的思考' },
  { name: '平静', color: '#B3E5FF', description: '如星空安稳' },
  { name: '生气', color: '#FFB3B3', description: '有些不愉快' },
  { name: '轻松', color: '#B3FFD9', description: '自在的呼吸' },
];

// --- Utils ---
const generateId = () => {
  try {
    return crypto.randomUUID();
  } catch (e) {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
};

// --- Hooks ---

function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [storedValue, setValue] as const;
}

// --- Sound Engine ---
let audioCtx: AudioContext | null = null;
const playSound = (type: 'add' | 'complete' | 'click') => {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    if (type === 'add') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, audioCtx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.2);
    } else if (type === 'complete') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
      gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.5);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 1.5);
    } else if (type === 'click') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1200, audioCtx.currentTime);
      gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.05);
    }
  } catch (e) {
    console.warn('Audio not supported or blocked', e);
  }
};

// --- Components ---

interface BackgroundProps {
  time: Date;
}

const Background = ({ time }: BackgroundProps) => {
  const hour = time.getHours();
  
  const theme = useMemo(() => {
    if (hour >= 5 && hour < 8) return 'dawn';
    if (hour >= 8 && hour < 17) return 'day';
    if (hour >= 17 && hour < 20) return 'evening';
    return 'night';
  }, [hour]);

  const gradients = {
    dawn: 'from-[#e2e8f0] to-[#f1f5f9]',
    day: 'from-[#cbd5e1] to-[#f8fafc]',
    evening: 'from-[#94a3b8] to-[#475569]',
    night: 'from-[#0a192f] to-[#020617]',
  };

  const isNightTheme = theme === 'night' || theme === 'evening';

  return (
    <div className={cn("fixed inset-0 -z-10 bg-gradient-to-br transition-colors duration-1000", gradients[theme])}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Background Stars (Only at night/evening) */}
        {isNightTheme && [...Array(30)].map((_, i) => (
          <motion.div
            key={`bg-star-${i}`}
            className="absolute bg-white rounded-full"
            style={{
              width: Math.random() * 2 + 0.5,
              height: Math.random() * 2 + 0.5,
              top: `${Math.random() * 100}%`,
              left: `${Math.random() * 100}%`,
              opacity: Math.random() * 0.3 + 0.1,
            }}
            animate={{
              opacity: [0.1, 0.4, 0.1],
            }}
            transition={{
              duration: Math.random() * 10 + 10,
              repeat: Infinity,
            }}
          />
        ))}
      </div>
    </div>
  );
};


// --- Error Boundary ---
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-900 text-white p-8 text-center">
          <h1 className="text-2xl font-serif mb-4">抱歉，应用遇到了点小麻烦</h1>
          <p className="text-sm opacity-60 mb-8 max-w-md">{this.state.error?.message || "未知错误"}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-8 py-3 bg-blue-500 rounded-full text-sm tracking-widest"
          >
            刷新重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Task Item Component ---
interface TaskItemProps {
  task: Task;
  isNight: boolean;
  toggleTask: (id: string) => void;
  deleteTask: (id: string) => void;
}

const TaskItem = ({ task, isNight, toggleTask, deleteTask }: TaskItemProps) => {
  const x = useMotionValue(0);
  const opacity = useTransform(x, [-70, -20, 0], [1, 0, 0]);
  const scale = useTransform(x, [-70, -20, 0], [1, 0.8, 0.5]);

  return (
    <div className="relative overflow-visible group">
      {/* Delete Action (Hidden behind) */}
      <motion.div 
        style={{ opacity, scale }}
        className="absolute right-0 top-0 bottom-0 flex items-center pr-1 z-0"
      >
        <button 
          onClick={() => deleteTask(task.id)}
          className={cn(
            "h-[80%] aspect-square rounded-2xl flex items-center justify-center transition-all active:scale-90",
            isNight ? "bg-red-400/10 text-red-400/40" : "bg-red-500/5 text-red-500/30"
          )}
          title="删除"
        >
          <Trash2 size={18} />
        </button>
      </motion.div>

      <motion.div
        layout
        drag="x"
        style={{ x }}
        dragConstraints={{ left: -70, right: 0 }}
        dragElastic={0.1}
        className={cn(
          "flex items-center gap-4 bg-transparent z-10 relative py-1 cursor-grab active:cursor-grabbing",
          task.completed && "opacity-40"
        )}
      >
        <button 
          onClick={() => toggleTask(task.id)}
          className={cn(
            "flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all",
            task.completed ? "bg-blue-500 border-blue-500" : "border-blue-400/30"
          )}
        >
          {task.completed && <Check size={14} className="text-white" />}
        </button>
        
        <div className="flex-1 flex items-center gap-3">
          <div className={cn(
            "w-2 h-2 rounded-full",
            task.category ? MORANDI_COLORS[task.category].bg : 'bg-blue-400/30'
          )} />
          <p className={cn(
            "text-lg font-light transition-all",
            task.completed && "line-through"
          )}>
            {task.text}
          </p>
        </div>
      </motion.div>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diaries, setDiaries] = useState<DiaryEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'list' | 'calendar' | 'diary'>('list');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(startOfDay(new Date()));
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTaskText, setNewTaskText] = useState('');
  const [newTaskCategory, setNewTaskCategory] = useState<TaskCategory>('WORK');
  const [isLoaded, setIsLoaded] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  
  // Diary State
  const [diaryContent, setDiaryContent] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  
  // Mood State
  const [selectedMood, setSelectedMood] = useState<string>(MOOD_COLORS[0].color);
  const [showMoodModal, setShowMoodModal] = useState(false);
  
  // AI Insights State
  const [isInsightLoading, setIsInsightLoading] = useState(false);
  const [weeklyInsight, setWeeklyInsight] = useState<string | null>(null);
  const [showInsightModal, setShowInsightModal] = useState(false);

  // Profile State
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [isAvatarLoading, setIsAvatarLoading] = useState(false);
  const [userProfile, setUserProfile] = useState<{ photoURL?: string, displayName?: string } | null>(null);
  const [customApiKey, setCustomApiKey] = useLocalStorage<string>('custom_gemini_api_key', '');
  const [customApiUrl, setCustomApiUrl] = useLocalStorage<string>('custom_gemini_api_url', '');
  const [customApiModel, setCustomApiModel] = useLocalStorage<string>('custom_gemini_api_model', 'gemini-3-flash-preview');
  const [customApiProtocol, setCustomApiProtocol] = useLocalStorage<'gemini' | 'openai'>('custom_api_protocol', 'gemini');
  const [showApiConfig, setShowApiConfig] = useState(false);
  const [isApiTesting, setIsApiTesting] = useState(false);
  const [apiTestResult, setApiTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>(['gemini-3-flash-preview', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gpt-4o', 'gpt-3.5-turbo', 'claude-3-sonnet-20240229']);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [themePreference, setThemePreference] = useLocalStorage<'light' | 'dark' | 'auto'>('theme_preference', 'auto');

  // Local Storage for Migration
  const [localTasks] = useLocalStorage<Task[]>('tasks', []);
  const [localDiaries] = useLocalStorage<DiaryEntry[]>('diaries', []);
  const [hasMigrated, setHasMigrated] = useLocalStorage<boolean>('has_migrated', false);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Data Migration Logic
  useEffect(() => {
    const migrate = async () => {
      if (user && !hasMigrated) {
        console.log("Starting data migration...");
        try {
          // Migrate Tasks
          for (const task of localTasks) {
            const taskRef = doc(db, 'tasks', task.id);
            await setDoc(taskRef, { ...task, uid: user.uid });
          }
          // Migrate Diaries
          for (const diary of localDiaries) {
            const diaryRef = doc(db, 'diaries', diary.id);
            await setDoc(diaryRef, { ...diary, uid: user.uid });
          }
          setHasMigrated(true);
          console.log("Migration complete!");
        } catch (error) {
          console.error("Migration failed:", error);
        }
      }
    };
    migrate();
  }, [user, hasMigrated, localTasks, localDiaries]);

  // Firestore Sync
  useEffect(() => {
    if (!user) {
      setTasks([]);
      setDiaries([]);
      setUserProfile(null);
      return;
    }

    const userRef = doc(db, 'users', user.uid);
    const unsubscribeUser = onSnapshot(userRef, (snapshot) => {
      if (snapshot.exists()) {
        setUserProfile(snapshot.data() as { photoURL?: string, displayName?: string });
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
    });

    const tasksQuery = query(collection(db, 'tasks'), where('uid', '==', user.uid));
    const unsubscribeTasks = onSnapshot(tasksQuery, (snapshot) => {
      const t = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Task));
      setTasks(t);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tasks');
    });

    const diariesQuery = query(collection(db, 'diaries'), where('uid', '==', user.uid));
    const unsubscribeDiaries = onSnapshot(diariesQuery, (snapshot) => {
      const d = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as DiaryEntry));
      setDiaries(d);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'diaries');
    });

    return () => {
      unsubscribeUser();
      unsubscribeTasks();
      unsubscribeDiaries();
    };
  }, [user]);

  const login = async () => {
    setLoginError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      console.error("Login Error:", error);
      if (error.code === 'auth/popup-blocked') {
        setLoginError("登录窗口被浏览器拦截，请允许弹出窗口。");
      } else if (error.code === 'auth/popup-closed-by-user') {
        // User closed the popup, no need to show error
      } else if (error.code === 'auth/unauthorized-domain') {
        setLoginError("当前域名未被授权。如果是克隆的应用，请点击设置重新配置 Firebase。");
      } else {
        setLoginError(`登录失败 (${error.code || '未知错误'})，请稍后重试。`);
      }
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout Error:", error);
    }
  };

  const testApiConnection = async () => {
    setIsApiTesting(true);
    setApiTestResult(null);
    try {
      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      const baseUrl = customApiUrl || undefined;
      const modelName = customApiModel || "gemini-3-flash-preview";
      const protocol = customApiProtocol;

      if (!apiKey) throw new Error("尚未配置 API 密钥");

      if (protocol === 'gemini') {
        const ai = new GoogleGenAI({ apiKey } as any);
        const model = (ai as any).getGenerativeModel({ model: modelName }, { baseUrl } as any);
        const result = await model.generateContent("你好，请回复“连接成功”");
        const response = await result.response;
        if (response.text()) {
          setApiTestResult({ success: true, message: "连接成功" });
        } else {
          throw new Error("响应内容为空");
        }
      } else {
        // OpenAI Compatible via Fetch
        const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: '你好，简短回复即可' }],
            max_tokens: 10
          })
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: resp.statusText } }));
          throw new Error(err.error?.message || `HTTP ${resp.status}`);
        }
        setApiTestResult({ success: true, message: "连接成功" });
      }
    } catch (error: any) {
      setApiTestResult({ success: false, message: error.message || "连接失败" });
    } finally {
      setIsApiTesting(false);
    }
  };

  const fetchAvailableModels = async () => {
    setIsFetchingModels(true);
    try {
      const apiKey = (customApiKey || process.env.GEMINI_API_KEY || '').trim();
      let baseUrl = (customApiUrl || '').trim().replace(/\/+$/, ''); // 去重尾部斜杠
      
      if (!apiKey) throw new Error("尚未配置 API 密钥");

      if (customApiProtocol === 'gemini') {
        const base = baseUrl || "https://generativelanguage.googleapis.com";
        // 自动处理路径版本，默认使用 v1beta
        const hasVersion = base.includes('/v1beta') || base.includes('/v1');
        const url = `${base}${hasVersion ? '' : '/v1beta'}/models?key=${apiKey}`;
        
        const resp = await fetch(url, {
          headers: {
            'x-goog-api-key': apiKey, // 增加 Header 认证支持（部分代理需要）
          }
        });
        
        if (!resp.ok) {
          let errorDetail = resp.statusText;
          if (resp.status === 401) errorDetail = "密钥无效或无权列出模型。如果是第三方代理，请检查 API 地址是否包含 /v1beta";
          if (resp.status === 403) errorDetail = "API Key 权限受限或 IP 已被封禁";
          throw new Error(`HTTP ${resp.status}: ${errorDetail}`);
        }
        
        const data = await resp.json();
        const models = data.models
          ?.filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m: any) => m.name.replace('models/', '')) || [];
          
        if (models.length > 0) {
          setAvailableModels(prev => Array.from(new Set([...prev, ...models])));
        } else {
          throw new Error("未能获取到有效的生成模型列表");
        }
      } else {
        // OpenAI 兼容协议
        const base = baseUrl || 'https://api.openai.com/v1';
        // 确保 OpenAI 路径包含 /models，通常在 base 后面
        const url = `${base}/models`;
        
        const resp = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (!resp.ok) {
          let errorDetail = resp.statusText;
          if (resp.status === 401) errorDetail = "密钥无效或代理地址错误。请检查 API 地址是否填写正确（通常需包含 /v1）";
          throw new Error(`HTTP ${resp.status}: ${errorDetail}`);
        }
        
        const data = await resp.json();
        const models = data.data?.map((m: any) => m.id) || [];
        
        if (models.length > 0) {
          setAvailableModels(prev => Array.from(new Set([...prev, ...models])));
        } else {
          throw new Error("服务器返回的模型列表为空");
        }
      }
      playSound('click');
    } catch (error: any) {
      console.error("Fetch Models Error:", error);
      alert(`无法获取模型列表:\n${error.message}`);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    // Check file size (limit to 1MB for base64 safety)
    if (file.size > 1024 * 1024) {
      alert("图片太大啦，请选择 1MB 以内的图片。");
      return;
    }

    setIsAvatarLoading(true);
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64String = reader.result as string;
      try {
        const userRef = doc(db, 'users', user.uid);
        await setDoc(userRef, { 
          uid: user.uid,
          photoURL: base64String,
          displayName: user.displayName,
          email: user.email,
          updatedAt: Date.now()
        }, { merge: true });
        
        playSound('complete');
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
        alert("更换头像失败，请重试。");
      } finally {
        setIsAvatarLoading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    setIsLoaded(true);
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    const introTimer = setTimeout(() => setShowIntro(false), 3500); // 3.5s intro
    return () => {
      clearInterval(timer);
      clearTimeout(introTimer);
    };
  }, []);

  // Ensure we always render something, even if isLoaded is false (though we set it immediately)
  // The Background and AnimatePresence (Intro) should be visible immediately.

  const generateWeeklyInsight = async () => {
    if (!user) return;
    setIsInsightLoading(true);
    setShowInsightModal(true);
    setWeeklyInsight(null);
    try {
      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      const baseUrl = customApiUrl || undefined;
      const modelName = customApiModel || "gemini-3-flash-preview";
      const protocol = customApiProtocol;

      if (!apiKey) throw new Error("API Key not found");
      
      const recentTasks = tasks.slice(-20).map(t => `${t.text} (${t.completed ? '已完成' : '未完成'})`).join('\n');
      const recentDiaries = diaries.slice(-5).map(d => d.content).join('\n\n');
      
      const prompt = `你是一个温柔、富有诗意的生活观察者。请根据我最近的计划和日记，为我生成一份本周的“星空周报”。
      
      最近的计划：
      ${recentTasks}
      
      最近的日记：
      ${recentDiaries}
      
      请包含：
      1. 一个富有诗意的总结标题。
      2. 对我本周努力的肯定。
      3. 一个关于下周的小建议，字数控制在200字以内。
      请使用中文，语气要像老朋友一样温暖。`;

      let aiText = "";
      if (protocol === 'gemini') {
        const ai = new GoogleGenAI({ apiKey } as any);
        const model = (ai as any).getGenerativeModel({ model: modelName }, { baseUrl } as any);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        aiText = response.text() || "星空有些模糊，请稍后再试。";
      } else {
        const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: prompt }]
          })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        aiText = data.choices[0].message.content;
      }
      setWeeklyInsight(aiText);
    } catch (error) {
      console.error("Insight Error:", error);
      setWeeklyInsight("连接星空失败，请检查网络。");
    } finally {
      setIsInsightLoading(false);
    }
  };

  const addTask = async () => {
    if (!newTaskText.trim() || !user) return;
    const newTask: Task = {
      text: newTaskText,
      completed: false,
      createdAt: startOfDay(selectedDate).getTime() + (Date.now() % (24 * 60 * 60 * 1000)),
      uid: user.uid,
      id: generateId(),
      category: newTaskCategory
    } as any;
    try {
      setShowAddModal(false);
      setNewTaskText('');
      setNewTaskCategory('WORK');
      playSound('add');
      await setDoc(doc(db, 'tasks', newTask.id), newTask);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `tasks/${newTask.id}`);
    }
  };

  const toggleTask = async (id: string) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    
    const isNowCompleted = !task.completed;
    
    if (isNowCompleted) {
      playSound('complete');
    } else {
      playSound('click');
    }
    
    try {
      await updateDoc(doc(db, 'tasks', id), { completed: isNowCompleted });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `tasks/${id}`);
    }
  };

  const deleteTask = async (id: string) => {
    playSound('click');
    try {
      await deleteDoc(doc(db, 'tasks', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `tasks/${id}`);
    }
  };

  const filteredTasks = useMemo(() => {
    return tasks.filter(t => isSameDay(new Date(t.createdAt), selectedDate));
  }, [tasks, selectedDate]);

  const stats = useMemo(() => {
    const grouped: Record<string, { total: number; completed: number }> = {};
    tasks.forEach(t => {
      if (!t.createdAt) return;
      try {
        const day = format(t.createdAt, 'yyyy-MM-dd');
        if (!grouped[day]) grouped[day] = { total: 0, completed: 0 };
        grouped[day].total++;
        if (t.completed) grouped[day].completed++;
      } catch (e) {
        console.error("Stats format error:", e);
      }
    });
    return grouped;
  }, [tasks]);

  const diaryMap = useMemo(() => {
    const map: Record<string, DiaryEntry> = {};
    diaries.forEach(d => {
      map[d.date] = d;
    });
    return map;
  }, [diaries]);

  const currentDiary = useMemo(() => {
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    return diaryMap[dateKey] || { id: '', date: dateKey, content: '', chatHistory: [] };
  }, [diaryMap, selectedDate]);

  useEffect(() => {
    setDiaryContent(currentDiary.content);
    setSelectedMood(currentDiary.moodColor || MOOD_COLORS[0].color);
  }, [currentDiary]);

  const saveDiary = async (content: string, mood?: string) => {
    if (!user) return;
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    const existing = diaries.find(d => d.date === dateKey);
    const moodToSave = mood || selectedMood;
    
    try {
      if (existing) {
        await updateDoc(doc(db, 'diaries', existing.id), { content, moodColor: moodToSave });
      } else {
        const newDiary = {
          id: generateId(),
          date: dateKey,
          content,
          moodColor: moodToSave,
          chatHistory: [],
          uid: user.uid
        };
        await setDoc(doc(db, 'diaries', newDiary.id), newDiary);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'diaries');
    }
  };

  const handleAiChat = async () => {
    if (!chatInput.trim() || isAiLoading || !user) return;
    
    const userMsg = chatInput;
    setChatInput('');
    setIsAiLoading(true);
    
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    const entry = diaries.find(d => d.date === dateKey) || { id: generateId(), date: dateKey, content: diaryContent, chatHistory: [], uid: user.uid };
    
    const newHistory = [...entry.chatHistory, { role: 'user' as const, text: userMsg }];
    
    try {
      // Save user message first
      if (diaries.find(d => d.date === dateKey)) {
        await updateDoc(doc(db, 'diaries', entry.id), { chatHistory: newHistory });
      } else {
        await setDoc(doc(db, 'diaries', entry.id), { ...entry, chatHistory: newHistory });
      }

      const apiKey = customApiKey || process.env.GEMINI_API_KEY;
      const baseUrl = customApiUrl || undefined;
      const modelName = customApiModel || "gemini-3-flash-preview";
      const protocol = customApiProtocol;

      if (!apiKey) throw new Error("API Key not found");

      // AI Memory Context
      const memoryContext = diaries
        .filter(d => d.date !== dateKey)
        .slice(-3)
        .map(d => `[${d.date}]: ${d.content}`)
        .join('\n');

      const systemInstruction = `你是一个观察着用户星空的知己。
这是用户过去几天的生活碎片（记忆）：
${memoryContext}

用户今天的日记：
${diaryContent}

如果上面的日记为空，说明用户现在正在对话中整理心情。
请结合记忆和现状，以自然、真诚的方式与用户对话。你可以参考用户提到的事展现出你一直在。如果用户要求你扮演特定角色，请配合。回复要简洁、温暖。`;

      let aiText = "";

      if (protocol === 'gemini') {
        const ai = new GoogleGenAI({ apiKey } as any);
        const model = (ai as any).getGenerativeModel({ 
          model: modelName,
          systemInstruction,
        }, { baseUrl } as any);

        const result = await model.generateContent({
          contents: newHistory.map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] })),
        });

        const response = await result.response;
        aiText = response.text() || "抱歉，我现在无法回应。";
      } else {
        const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'system', content: systemInstruction },
              ...newHistory.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text }))
            ]
          })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        aiText = data.choices[0].message.content;
      }
      
      const finalHistory = [...newHistory, { role: 'model' as const, text: aiText }];
      await updateDoc(doc(db, 'diaries', entry.id), { chatHistory: finalHistory });
    } catch (error) {
      console.error('AI Chat Error:', error);
      const errorMsg = { 
        role: 'model' as const, 
        text: customApiKey 
          ? "连接星空失败，请检查你的 API Key 是否有效，或检查网络连接。" 
          : "连接星空失败，未在该克隆应用中配置 GEMINI_API_KEY。请在设置中输入你的私人 API Key。" 
      };
      if (entry.id) {
        try {
          await updateDoc(doc(db, 'diaries', entry.id), { chatHistory: [...newHistory, errorMsg] });
        } catch (e) {
          console.error('Failed to save error message to Firestore:', e);
        }
      }
    } finally {
      setIsAiLoading(false);
    }
  };

  const displayTime = useMemo(() => {
    if (themePreference === 'dark') {
      const d = new Date(currentTime);
      d.setHours(20, 0, 0, 0); // 参考晚上八点
      return d;
    }
    if (themePreference === 'light') {
      const d = new Date(currentTime);
      d.setHours(12, 0, 0, 0); // 参考中午十二点
      return d;
    }
    return currentTime;
  }, [themePreference, currentTime]);

  const isNight = displayTime.getHours() >= 20 || displayTime.getHours() < 5;

  return (
    <ErrorBoundary>
      <div className={cn("h-screen flex flex-col items-center justify-center p-4 md:p-8 overflow-hidden transition-colors duration-1000", isNight ? "text-white" : "text-slate-900")}>
        <Background time={displayTime} />

      <AnimatePresence mode="wait">
        {showIntro && (
          <motion.div
            key="intro"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.5, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden transition-colors duration-1000",
              isNight 
                ? "bg-gradient-to-b from-[#020617] via-[#020617] to-[#0f172a] text-white" 
                : "bg-gradient-to-b from-[#f8fafc] via-[#cbd5e1] to-[#94a3b8] text-slate-900"
            )}
          >
            {/* Atmospheric Glow */}
            <motion.div
              initial={{ opacity: 0, scale: 0.8, y: 100 }}
              animate={{ opacity: [0, 0.2, 0.1], scale: [0.8, 1.2, 1.1], y: [100, 0, -20] }}
              transition={{ duration: 2.5, ease: "easeOut" }}
              className={cn(
                "absolute w-[150%] aspect-square rounded-full blur-[120px] -bottom-1/2",
                isNight ? "bg-gradient-to-t from-blue-400/20 via-transparent to-transparent" : "bg-gradient-to-t from-white/40 via-transparent to-transparent"
              )}
            />

            <div className="relative z-10 flex flex-col items-center">
              <motion.div
                initial={{ opacity: 0, letterSpacing: "1em", filter: "blur(10px)" }}
                animate={{ opacity: 1, letterSpacing: "0.5em", filter: "blur(0px)" }}
                transition={{ duration: 2, ease: [0.22, 1, 0.36, 1] }}
                className="flex items-center"
              >
                <h1 className={cn(
                  "text-8xl font-serif tracking-tighter mix-blend-difference",
                  isNight ? "text-white" : "text-slate-900"
                )}>
                  既白
                </h1>
              </motion.div>

              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "40px", opacity: 0.3 }}
                transition={{ delay: 0.8, duration: 1.2, ease: "easeInOut" }}
                className="h-px bg-current mt-12"
              />

              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 0.4, y: 0 }}
                transition={{ delay: 1.2, duration: 1 }}
                className="text-[9px] tracking-[0.6em] uppercase font-medium mt-8"
              >
                FIRST LIGHT OF DAWN
              </motion.p>
            </div>

            {/* Subtle light particles */}
            <div className="absolute inset-0 pointer-events-none">
              {[...Array(15)].map((_, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: [0, 0.3, 0], y: -100 }}
                  transition={{ 
                    duration: Math.random() * 3 + 3, 
                    repeat: Infinity, 
                    delay: Math.random() * 2,
                    ease: "linear"
                  }}
                  className="absolute w-px h-px bg-white rounded-full"
                  style={{
                    left: `${Math.random() * 100}%`,
                    top: `${Math.random() * 100 + 50}%`,
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!showIntro && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.2 }}
          className="w-full max-w-2xl flex flex-col h-full relative"
        >
          {!isAuthReady ? (
            <div className="flex-1 flex items-center justify-center">
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="w-6 h-6 border-2 border-blue-500/20 border-t-blue-500 rounded-full"
              />
            </div>
          ) : !user ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-8">
              <div className="space-y-3">
                <h2 className="text-4xl font-serif italic tracking-tight">既白</h2>
                <p className="text-xs opacity-40 tracking-[0.4em] uppercase font-medium">记录每一个晨曦与星空</p>
              </div>

              <div className="max-w-xs mx-auto">
                <p className="text-sm opacity-30 leading-relaxed italic">“在这里，你的每一个念头都如星辰般闪耀。”</p>
              </div>

              <button 
                onClick={login}
                className="px-12 py-4 bg-blue-500 text-white rounded-full text-sm tracking-[0.2em] font-medium shadow-2xl shadow-blue-500/30 hover:bg-blue-600 transition-all active:scale-95"
              >
                使用 Google 登录
              </button>

              {loginError && (
                <motion.p 
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-xs text-red-400/80 font-light"
                >
                  {loginError}
                </motion.p>
              )}
            </div>
          ) : (
            <>
              {/* Header */}
              <header className="p-8 pb-4 flex justify-between items-end shrink-0">
                <div className="flex items-center gap-4">
                  {!isSameDay(selectedDate, new Date()) && activeTab === 'list' && (
                    <button 
                      onClick={() => { playSound('click'); setActiveTab('calendar'); }}
                      className="p-2 glass rounded-full opacity-60 hover:opacity-100 transition-opacity"
                    >
                      <ChevronLeft size={20} />
                    </button>
                  )}
                  <div>
                    <h1 className="text-4xl font-serif italic tracking-tight">既白</h1>
                    <p className="text-xs opacity-60 mt-1 font-medium tracking-widest uppercase">
                      {format(selectedDate, 'MMMM do, EEEE')}
                    </p>
                  </div>
                </div>
                
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={generateWeeklyInsight}
                      className="p-2 glass rounded-full text-blue-400 hover:text-blue-300 transition-colors"
                      title="星空周报"
                    >
                      <Sparkles size={18} />
                    </button>
                    <button 
                      onClick={() => { playSound('click'); setShowProfileModal(true); }}
                      className="relative group transition-transform active:scale-95"
                    >
                      <img 
                        src={userProfile?.photoURL || user.photoURL || `https://ui-avatars.com/api/?name=${userProfile?.displayName || user.displayName || 'User'}`} 
                        alt="Avatar" 
                        className="w-8 h-8 rounded-full border border-white/20 group-hover:border-blue-400/50 transition-colors object-cover"
                        referrerPolicy="no-referrer"
                      />
                      <div className="absolute inset-0 rounded-full bg-blue-400/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  </div>
                </div>
              </header>

              {/* Content */}
              <main className="flex-1 overflow-y-auto px-4 py-4 custom-scrollbar">
                <AnimatePresence mode="wait">
            {activeTab === 'list' && (
              <motion.div
                key="list"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-6"
              >
                <div className="flex justify-between items-center mb-8">
                  <div className="flex-1 mr-4">
                    <div className="flex justify-between items-end mb-2">
                      <p className="text-[10px] uppercase tracking-widest opacity-40 font-bold">当日进度</p>
                      <p className="text-[10px] opacity-40 font-serif italic">
                        {filteredTasks.filter(t => t.completed).length} / {filteredTasks.length}
                      </p>
                    </div>
                    <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: filteredTasks.length > 0 ? `${(filteredTasks.filter(t => t.completed).length / filteredTasks.length) * 100}%` : 0 }}
                        className="h-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                      />
                    </div>
                  </div>
                  <button 
                    onClick={() => {
                      playSound('click');
                      setShowAddModal(true);
                    }}
                    className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-lg hover:scale-105 transition-transform shrink-0"
                  >
                    <Plus size={20} />
                  </button>
                </div>

                {filteredTasks.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center opacity-30 py-20 text-center">
                    <Star size={48} className="mb-4" />
                    <p className="font-serif italic">每个计划的开始都是黎明</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredTasks
                      .sort((a, b) => (a.completed === b.completed ? 0 : a.completed ? 1 : -1))
                      .map(task => (
                        <TaskItem 
                          key={task.id} 
                          task={task} 
                          isNight={isNight} 
                          toggleTask={toggleTask} 
                          deleteTask={deleteTask} 
                        />
                      ))}
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'calendar' && (
              <motion.div
                key="calendar"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
              >
                <StarryCalendar 
                  stats={stats} 
                  diaryMap={diaryMap}
                  isNight={isNight} 
                  selectedDate={selectedDate}
                  onSelectDate={(date) => {
                    setSelectedDate(date);
                    setActiveTab('list');
                  }}
                />
              </motion.div>
            )}

            {activeTab === 'diary' && (
              <motion.div
                key="diary"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="h-full flex flex-col space-y-6"
              >
                <div className="flex-1 flex flex-col overflow-hidden relative bg-white/5 backdrop-blur-sm rounded-[2.5rem] p-8">
                  <div className="flex justify-between items-center mb-8 px-2">
                    <div className="flex items-center gap-4">
                      <p className="text-[10px] uppercase tracking-[0.4em] opacity-40 font-bold">每日心语</p>
                      <button 
                        onClick={() => setShowMoodModal(true)}
                        className="flex items-center gap-2 px-3 py-1 glass rounded-full hover:bg-white/5 transition-colors"
                      >
                        <div 
                          className="w-2 h-2 rounded-full" 
                          style={{ 
                            backgroundColor: selectedMood,
                            boxShadow: `0 0 8px ${selectedMood}80`
                          }} 
                        />
                        <span className="text-[10px] opacity-60 tracking-widest">
                          {MOOD_COLORS.find(m => m.color === selectedMood)?.name || '记录心情'}
                        </span>
                      </button>
                    </div>
                    <button 
                      onClick={() => setIsChatting(true)}
                      className="p-2 glass rounded-full opacity-60 hover:opacity-100 transition-opacity"
                    >
                      <MessageSquare size={18} />
                    </button>
                  </div>
                  <textarea
                    value={diaryContent}
                    onChange={(e) => {
                      setDiaryContent(e.target.value);
                      saveDiary(e.target.value);
                    }}
                    placeholder="此刻，你想记录下什么？"
                    className="flex-1 bg-transparent border-none focus:ring-0 outline-none px-2 text-lg font-light leading-relaxed placeholder:opacity-20 resize-none custom-scrollbar min-h-[200px]"
                    spellCheck={false}
                  />
                </div>
              </motion.div>
            )}
                </AnimatePresence>
              </main>

              {/* Navigation */}
              <nav className="px-8 pt-2 pb-10 flex justify-around border-t border-white/10 shrink-0">
                <NavButton active={activeTab === 'list'} onClick={() => { playSound('click'); setActiveTab('list'); }} icon={<List size={20} />} />
                <NavButton active={activeTab === 'calendar'} onClick={() => { playSound('click'); setActiveTab('calendar'); }} icon={<CalendarIcon size={20} />} />
                <NavButton active={activeTab === 'diary'} onClick={() => { playSound('click'); setActiveTab('diary'); }} icon={<BookOpen size={20} />} />
              </nav>

              {/* Full Screen Chat Overlay */}
              <AnimatePresence>
                {isChatting && (
                  <motion.div
                    initial={{ opacity: 0, scale: 1.05, filter: "blur(10px)" }}
                    animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                    exit={{ opacity: 0, scale: 1.05, filter: "blur(10px)" }}
                    transition={{ 
                      duration: 0.6, 
                      ease: [0.22, 1, 0.36, 1]
                    }}
                    className={cn(
                      "fixed inset-0 z-[80] flex flex-col p-8 md:p-12 transition-colors duration-500",
                      isNight ? "bg-[#020617]" : "bg-[#f8fafc]"
                    )}
                  >
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2, duration: 0.5 }}
                      className="flex justify-between items-center mb-12"
                    >
                      <div className="flex flex-col">
                        <p className="text-[10px] uppercase tracking-[0.5em] opacity-40 font-bold mb-2">星空对话</p>
                        <h2 className="text-2xl font-serif italic text-white/90">{format(selectedDate, 'MMMM do')}</h2>
                      </div>
                      <button 
                        onClick={() => setIsChatting(false)}
                        className="p-4 glass rounded-full opacity-60 hover:opacity-100 transition-all hover:scale-110 active:scale-95"
                      >
                        <ChevronLeft size={24} />
                      </button>
                    </motion.div>
                    
                    <div className="flex-1 overflow-y-auto space-y-6 mb-8 custom-scrollbar pr-4">
                      {currentDiary.chatHistory.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center opacity-20 text-center px-12 space-y-4">
                          <MessageSquare size={48} strokeWidth={1} />
                          <p className="text-lg italic font-light tracking-widest">“在这里，你可以和我聊聊今天的感悟。”</p>
                        </div>
                      )}
                      {currentDiary.chatHistory.map((msg, i) => (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.3 + (i * 0.05), duration: 0.4 }}
                          key={i} 
                          className={cn(
                            "max-w-[85%] md:max-w-[70%] p-6 rounded-[2.5rem] text-base leading-relaxed shadow-2xl",
                            msg.role === 'user' 
                              ? "ml-auto bg-blue-500/10 text-blue-100 rounded-tr-none border border-blue-500/10" 
                              : "mr-auto glass text-white/90 rounded-tl-none border border-white/5"
                          )}
                        >
                          {msg.text}
                        </motion.div>
                      ))}
                      {isAiLoading && (
                        <div className="mr-auto glass p-6 rounded-[2.5rem] rounded-tl-none flex gap-2 border border-white/5">
                          <motion.div animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1.5 h-1.5 bg-white rounded-full" />
                          <motion.div animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1.5 h-1.5 bg-white rounded-full" />
                          <motion.div animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1.5 h-1.5 bg-white rounded-full" />
                        </div>
                      )}
                    </div>

                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.4, duration: 0.5 }}
                      className="relative max-w-4xl mx-auto w-full"
                    >
                      <div className="absolute inset-0 bg-blue-500/5 blur-3xl rounded-full -z-10" />
                      <input
                        type="text"
                        autoFocus
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAiChat()}
                        placeholder="向星空提问..."
                        className="w-full bg-white/5 border border-white/10 rounded-[2rem] py-6 pl-8 pr-20 text-lg font-light focus:ring-2 focus:ring-blue-500/30 outline-none backdrop-blur-xl transition-all placeholder:opacity-20"
                      />
                      <button 
                        onClick={handleAiChat}
                        disabled={isAiLoading}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-4 bg-blue-500 text-white rounded-full hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20 disabled:opacity-20 active:scale-95"
                      >
                        <Send size={24} />
                      </button>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}

        {/* Add Modal */}
        <AnimatePresence>
          {showAddModal && (
            <motion.div 
              initial={{ opacity: 0, scale: 1.05 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              className={cn(
              "fixed inset-0 z-[60] glass backdrop-blur-2xl flex flex-col p-6 md:p-10 overflow-y-auto transition-colors duration-500",
              isNight ? "bg-black/40" : "bg-white/40",
              "pb-[safe-area-inset-bottom]"
            )}
            >
              <div className="flex justify-between items-center mb-16">
                <h2 className={cn(
                  "text-3xl font-serif italic transition-colors duration-500",
                  isNight ? "text-white" : "text-slate-900"
                )}>新计划</h2>
                <button 
                  onClick={() => {
                    playSound('click');
                    setShowAddModal(false);
                  }} 
                  className={cn(
                    "p-2 transition-all duration-500",
                    isNight ? "text-white opacity-40 hover:opacity-100" : "text-slate-900 opacity-40 hover:opacity-100"
                  )}
                >
                  <ChevronLeft size={28} />
                </button>
              </div>

              <div className="flex-1 flex flex-col space-y-12">
                <input 
                  autoFocus
                  type="text"
                  value={newTaskText}
                  onChange={(e) => setNewTaskText(e.target.value)}
                  placeholder="在此输入你的计划..."
                  className={cn(
                    "bg-transparent text-2xl md:text-3xl font-light focus:ring-0 focus:outline-none w-full px-6 py-4 rounded-2xl border transition-all duration-500",
                    isNight 
                      ? "border-white/20 text-white placeholder:text-white/20" 
                      : "border-slate-900/20 text-slate-900 placeholder:text-slate-900/20"
                  )}
                  onKeyDown={(e) => e.key === 'Enter' && addTask()}
                />

                <div className="space-y-4">
                  <p className={cn(
                    "text-[10px] uppercase tracking-[0.3em] font-bold transition-opacity duration-500",
                    isNight ? "text-white opacity-30" : "text-slate-900 opacity-30"
                  )}>类别</p>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {Object.entries(MORANDI_COLORS).map(([key, config]) => (
                      <button
                        key={key}
                        onClick={() => {
                          playSound('click');
                          setNewTaskCategory(key as TaskCategory);
                        }}
                        className={cn(
                          "flex items-center gap-2 p-3 rounded-2xl border transition-all duration-300",
                          newTaskCategory === key 
                            ? "bg-white text-slate-900 border-white shadow-xl" 
                            : isNight 
                              ? "bg-white/5 border-white/10 text-white opacity-40"
                              : "bg-black/5 border-black/10 text-slate-900 opacity-40"
                        )}
                      >
                        <div className={cn("w-2 h-2 rounded-full", config.bg)} />
                        <span className="text-[10px] tracking-widest uppercase">{config.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-auto pt-8">
                <button 
                  onClick={addTask}
                  className="w-full py-5 md:py-6 bg-blue-500 text-white rounded-[2rem] md:rounded-[2.5rem] text-sm tracking-[0.2em] font-medium shadow-2xl shadow-blue-500/30 hover:bg-blue-600 transition-all active:scale-[0.98]"
                >
                  开启黎明
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Profile Modal */}
        <AnimatePresence>
          {showProfileModal && user && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] glass backdrop-blur-3xl flex items-center justify-center p-6"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="max-w-sm w-full glass rounded-[3rem] p-10 relative overflow-hidden"
              >
                <div className="flex justify-between items-center mb-10">
                  <div className="flex items-center gap-3">
                    {showApiConfig && (
                      <button 
                        onClick={() => setShowApiConfig(false)}
                        className="p-2 -ml-2 opacity-40 hover:opacity-100 transition-opacity"
                      >
                        <ChevronLeft size={24} />
                      </button>
                    )}
                    <h2 className="text-2xl font-serif italic">{showApiConfig ? 'API 设置' : '个人中心'}</h2>
                  </div>
                  <button 
                    onClick={() => {
                      setShowProfileModal(false);
                      setShowApiConfig(false);
                    }}
                    className="p-2 opacity-40 hover:opacity-100 transition-opacity"
                  >
                    <Plus size={24} className="rotate-45" />
                  </button>
                </div>

                <AnimatePresence mode="wait">
                  {!showApiConfig ? (
                    <motion.div 
                      key="profile-main"
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className="flex flex-col items-center text-center space-y-6"
                    >
                      <div className="relative group cursor-pointer" onClick={() => document.getElementById('avatar-upload')?.click()}>
                        <div className={cn(
                          "relative w-24 h-24 rounded-full border-2 border-white/10 p-1 transition-all group-hover:border-blue-400/50",
                          isAvatarLoading && "opacity-50"
                        )}>
                          <img 
                            src={userProfile?.photoURL || user.photoURL || `https://ui-avatars.com/api/?name=${userProfile?.displayName || user.displayName || 'User'}`} 
                            alt="Avatar" 
                            className="w-full h-full rounded-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                          {isAvatarLoading ? (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                            </div>
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                              <Camera size={24} className="text-white" />
                            </div>
                          )}
                        </div>
                        <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center border-2 border-[#1e1e1e]">
                          <Star size={12} className="text-white" />
                        </div>
                        <input 
                          type="file" 
                          id="avatar-upload" 
                          className="hidden" 
                          accept="image/*" 
                          onChange={handleAvatarChange}
                          disabled={isAvatarLoading}
                        />
                      </div>

                      <div className="space-y-1">
                        <h3 className="text-xl font-medium">{userProfile?.displayName || user.displayName || '星空旅者'}</h3>
                        <p className="text-xs opacity-40 font-mono tracking-wider">{user.email}</p>
                      </div>

                      <div className="w-full grid grid-cols-2 gap-4 pt-4">
                        <div className="glass rounded-2xl p-4 flex flex-col items-center gap-1">
                          <span className="text-lg font-serif italic">{tasks.length}</span>
                          <span className="text-[10px] opacity-40 uppercase tracking-widest">计划总数</span>
                        </div>
                        <div className="glass rounded-2xl p-4 flex flex-col items-center gap-1">
                          <span className="text-lg font-serif italic">{diaries.length}</span>
                          <span className="text-[10px] opacity-40 uppercase tracking-widest">日记篇数</span>
                        </div>
                      </div>

                      <div className="w-full pt-4 space-y-3">
                        <button 
                          onClick={() => {
                            playSound('click');
                            setShowApiConfig(true);
                          }}
                          className="w-full flex items-center justify-between p-5 glass rounded-2xl hover:bg-white/5 transition-all group"
                        >
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
                              <Settings size={18} />
                            </div>
                            <span className="text-sm font-medium">星空对话 API 设置</span>
                          </div>
                          <ChevronRight size={18} className="opacity-20 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
                        </button>

                        <div className="flex items-center gap-2 p-1.5 glass rounded-2xl">
                          {[
                            { id: 'light', icon: Sun, label: '白昼' },
                            { id: 'dark', icon: Moon, label: '星夜' },
                            { id: 'auto', icon: Sparkles, label: '随行' }
                          ].map((t) => {
                            const Icon = t.icon;
                            return (
                              <button
                                key={t.id}
                                onClick={() => {
                                  setThemePreference(t.id as any);
                                  playSound('click');
                                }}
                                className={cn(
                                  "flex-1 flex items-center justify-center gap-2 py-3 rounded-xl transition-all text-xs font-medium",
                                  themePreference === t.id 
                                    ? "bg-blue-500 text-white shadow-lg" 
                                    : "opacity-40 hover:opacity-100"
                                )}
                              >
                                <Icon size={14} />
                                <span>{t.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="w-full pt-8">
                        <button 
                          onClick={() => {
                            playSound('click');
                            setShowProfileModal(false);
                            logout();
                          }}
                          className="w-full flex items-center justify-center gap-3 py-4 bg-red-500/10 text-red-400 border border-red-500/20 rounded-2xl hover:bg-red-500/20 transition-all active:scale-95 group"
                        >
                          <LogOut size={18} className="group-hover:-translate-x-1 transition-transform" />
                          <span className="text-sm tracking-widest font-medium">退出登录</span>
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="api-config"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      className="space-y-6"
                    >
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <p className={cn(
                            "text-[10px] uppercase tracking-[0.2em] font-bold px-1",
                            isNight ? "opacity-60 text-white" : "text-blue-950/40"
                          )}>API 协议</p>
                          <div className={cn(
                            "flex gap-2 p-1.5 glass rounded-xl border transition-colors",
                            isNight ? "border-white/5" : "border-blue-900/10"
                          )}>
                            {['gemini', 'openai'].map((p) => (
                              <button
                                key={p}
                                onClick={() => setCustomApiProtocol(p as any)}
                                className={cn(
                                  "flex-1 py-2 text-[11px] rounded-lg transition-all capitalize font-medium",
                                  customApiProtocol === p 
                                    ? "bg-blue-500 text-white shadow-lg shadow-blue-500/20" 
                                    : isNight ? "opacity-40 hover:opacity-100 text-white" : "text-blue-900/40 hover:text-blue-900 hover:bg-blue-900/5"
                                )}
                              >
                                {p === 'gemini' ? 'Gemini (SDK)' : 'OpenAI 兼容'}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <p className={cn(
                            "text-[10px] uppercase tracking-[0.2em] font-bold px-1",
                            isNight ? "opacity-60 text-white" : "text-blue-950/40"
                          )}>API 地址</p>
                          <input 
                            type="text"
                            placeholder={customApiProtocol === 'gemini' ? "https://generativelanguage.googleapis.com" : "https://api.openai.com/v1"}
                            value={customApiUrl}
                            onChange={(e) => setCustomApiUrl(e.target.value)}
                            className={cn(
                              "w-full border rounded-xl py-3.5 px-4 text-sm focus:ring-2 focus:ring-blue-500/50 outline-none transition-all",
                              isNight 
                                ? "bg-white/10 border-white/20 text-white placeholder:text-white/20" 
                                : "bg-blue-900/5 border-blue-900/10 text-blue-950 placeholder:text-blue-900/20"
                            )}
                          />
                        </div>

                        <div className="space-y-2">
                          <p className={cn(
                            "text-[10px] uppercase tracking-[0.2em] font-bold px-1",
                            isNight ? "opacity-60 text-white" : "text-blue-950/40"
                          )}>API 密钥 (Key)</p>
                          <input 
                            type="password"
                            placeholder="输入 API Key..."
                            value={customApiKey}
                            onChange={(e) => setCustomApiKey(e.target.value)}
                            className={cn(
                              "w-full border rounded-xl py-3.5 px-4 text-sm focus:ring-2 focus:ring-blue-500/50 outline-none transition-all",
                              isNight 
                                ? "bg-white/10 border-white/20 text-white placeholder:text-white/20" 
                                : "bg-blue-900/5 border-blue-900/10 text-blue-950 placeholder:text-blue-900/20"
                            )}
                          />
                        </div>

                        <div className="space-y-2 relative">
                          <p className={cn(
                            "text-[10px] uppercase tracking-[0.2em] font-bold px-1 flex justify-between items-center",
                            isNight ? "opacity-60 text-white" : "text-blue-950/40"
                          )}>
                            <span>模型选择</span>
                            <button 
                              onClick={fetchAvailableModels}
                              disabled={isFetchingModels}
                              className={cn(
                                "flex items-center gap-1.5 transition-colors py-1 px-2 -mr-2 rounded-lg border active:scale-95",
                                isNight 
                                  ? "text-blue-400 hover:text-blue-200 bg-blue-500/10 border-blue-500/10" 
                                  : "text-blue-600 hover:text-blue-800 bg-blue-600/5 border-blue-600/5"
                              )}
                              title="从服务器刷新模型列表"
                            >
                              {isFetchingModels ? (
                                <div className={cn(
                                  "w-2.5 h-2.5 border-2 rounded-full animate-spin",
                                  isNight ? "border-blue-400/30 border-t-blue-400" : "border-blue-600/30 border-t-blue-600"
                                )} />
                              ) : (
                                <Plus size={11} className="rotate-45 scale-125" /> 
                              )}
                              <span className="text-[9px] uppercase tracking-wider font-bold">读取列表</span>
                            </button>
                          </p>
                          <div className="relative">
                            <input 
                              type="text"
                              list="api-models"
                              value={customApiModel}
                              onChange={(e) => setCustomApiModel(e.target.value)}
                              className={cn(
                                "w-full border rounded-xl py-3.5 px-4 text-sm focus:ring-2 focus:ring-blue-500/50 outline-none transition-all",
                                isNight 
                                  ? "bg-white/10 border-white/20 text-white" 
                                  : "bg-blue-900/5 border-blue-900/10 text-blue-950"
                              )}
                            />
                            <datalist id="api-models">
                              {availableModels.map(m => (
                                <option key={m} value={m} />
                              ))}
                            </datalist>
                          </div>
                          
                          {availableModels.length > 0 && (
                            <div className="mt-3 space-y-2">
                              <p className={cn(
                                "text-[9px] px-1 font-medium",
                                isNight ? "opacity-60 text-white" : "text-blue-950/40"
                              )}>已拉取模型 (点击选择):</p>
                              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-1 scrollbar-hide">
                                {availableModels.map(m => (
                                  <button
                                    key={m}
                                    onClick={() => {
                                      setCustomApiModel(m);
                                      playSound('click');
                                    }}
                                    className={cn(
                                      "px-3 py-1.5 rounded-lg text-[10px] transition-all font-medium border",
                                      customApiModel === m 
                                        ? "bg-blue-500 text-white shadow-lg shadow-blue-500/30 border-blue-400" 
                                        : isNight 
                                          ? "bg-white/10 text-white hover:bg-white/20 border-white/10" 
                                          : "bg-blue-900/5 text-blue-900 hover:bg-blue-900/10 border-blue-900/5"
                                    )}
                                  >
                                    {m}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="pt-4 space-y-3">
                        <button 
                          onClick={testApiConnection}
                          disabled={isApiTesting}
                          className={cn(
                            "w-full py-3 rounded-xl text-xs font-medium border transition-all flex items-center justify-center gap-2",
                            apiTestResult?.success 
                              ? "bg-green-500/10 border-green-500/30 text-green-400" 
                              : isNight ? "bg-white/5 border-white/10 text-white hover:bg-white/10" : "bg-blue-900/5 border-blue-900/10 text-blue-900 hover:bg-blue-900/10"
                          )}
                        >
                          {isApiTesting ? (
                            <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          ) : (
                            <Sparkles size={14} />
                          )}
                          {apiTestResult?.success ? "测试成功" : "测试连接"}
                        </button>

                        <button 
                          onClick={() => {
                            playSound('click');
                            setShowApiConfig(false);
                          }}
                          className="w-full py-4 bg-blue-500 text-white rounded-2xl text-sm font-medium shadow-lg shadow-blue-500/20 active:scale-95 transition-all"
                        >
                          保存并返回
                        </button>
                        
                        {apiTestResult && !apiTestResult.success && (
                          <p className="text-[10px] text-red-400 text-center px-4 animate-shake">
                            {apiTestResult.message}
                          </p>
                        )}
                      </div>

                      <p className="text-[10px] opacity-20 px-1 leading-relaxed text-center italic">
                        配置将保存在本地浏览器中，不会上传到云端。
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mood Selection Modal */}
        <AnimatePresence>
          {showMoodModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] glass backdrop-blur-2xl flex items-center justify-center p-6"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="max-w-sm w-full glass rounded-[3rem] p-10"
              >
                <div className="flex justify-between items-center mb-10">
                  <h2 className="text-2xl font-serif italic">今日心情</h2>
                  <button 
                    onClick={() => setShowMoodModal(false)}
                    className="p-2 opacity-40 hover:opacity-100 transition-opacity"
                  >
                    <Plus size={24} className="rotate-45" />
                  </button>
                </div>

                <div className="space-y-4">
                  {MOOD_COLORS.map(m => (
                    <button
                      key={m.color}
                      onClick={() => {
                        setSelectedMood(m.color);
                        saveDiary(diaryContent, m.color);
                        setShowMoodModal(false);
                        playSound('click');
                      }}
                      className={cn(
                        "w-full flex items-center justify-between p-4 rounded-2xl transition-all",
                        selectedMood === m.color ? "bg-white/10" : "hover:bg-white/5"
                      )}
                    >
                      <div className="flex items-center gap-4">
                        <div 
                          className="w-3 h-3 rounded-full" 
                          style={{ 
                            backgroundColor: m.color,
                            boxShadow: `0 0 12px ${m.color}80`
                          }} 
                        />
                        <span className="text-sm tracking-widest">{m.name}</span>
                      </div>
                      <span className="text-[10px] opacity-30 italic">{m.description}</span>
                    </button>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* AI Insight Modal */}
        <AnimatePresence>
          {showInsightModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] glass backdrop-blur-3xl flex items-center justify-center p-6"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="max-w-lg w-full glass rounded-[3rem] p-10 relative overflow-hidden"
              >
                {/* Decorative Elements */}
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-blue-500/50 to-transparent" />
                
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-500/20 rounded-full text-blue-400">
                      <Sparkles size={24} />
                    </div>
                    <h2 className="text-2xl font-serif italic">星空周报</h2>
                  </div>
                  <button 
                    onClick={() => setShowInsightModal(false)}
                    className="p-2 opacity-40 hover:opacity-100 transition-opacity"
                  >
                    <Plus size={24} className="rotate-45" />
                  </button>
                </div>

                <div className="space-y-6 min-h-[200px] flex flex-col justify-center">
                  {isInsightLoading ? (
                    <div className="flex flex-col items-center gap-4 py-12">
                      <motion.div 
                        animate={{ rotate: 360 }} 
                        transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
                        className="text-blue-400"
                      >
                        <Star size={40} />
                      </motion.div>
                      <p className="text-sm opacity-40 animate-pulse">正在解读星空的暗示...</p>
                    </div>
                  ) : (
                    <div className="prose prose-invert max-w-none">
                      <div className="text-white/90 leading-relaxed whitespace-pre-wrap font-light italic">
                        {weeklyInsight}
                      </div>
                    </div>
                  )}
                </div>

                {!isInsightLoading && (
                  <div className="mt-10 pt-8 border-t border-white/5 text-center">
                    <p className="text-[10px] uppercase tracking-[0.3em] opacity-30 font-bold mb-6">愿你拥有宁静的一周</p>
                    <button 
                      onClick={() => setShowInsightModal(false)}
                      className="px-10 py-4 glass rounded-full text-xs tracking-widest uppercase font-medium hover:bg-white/10 transition-all"
                    >
                      收起
                    </button>
                  </div>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    )}

    </div>
    </ErrorBoundary>
  );
}

const NavButton = ({ active, onClick, icon }: { active: boolean, onClick: () => void, icon: React.ReactNode }) => (
  <button 
    onClick={onClick}
    className={cn(
      "p-3 rounded-2xl transition-all duration-300",
      active ? "bg-blue-500/20 text-blue-400 shadow-inner" : "opacity-40 hover:opacity-70"
    )}
  >
    {icon}
  </button>
);

const StarryCalendar = ({ stats, diaryMap, isNight, selectedDate, onSelectDate }: { 
  stats: Record<string, { total: number; completed: number }>, 
  diaryMap: Record<string, DiaryEntry>,
  isNight: boolean,
  selectedDate: Date,
  onSelectDate: (date: Date) => void
}) => {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  
  const days = useMemo(() => {
    const start = startOfMonth(currentMonth);
    const end = endOfMonth(currentMonth);
    const interval = eachDayOfInterval({ start, end });
    
    // Pad start
    const startDay = getDay(start);
    const padding = Array(startDay).fill(null);
    
    return [...padding, ...interval];
  }, [currentMonth]);

  const getStarLevel = (date: Date) => {
    const key = format(date, 'yyyy-MM-dd');
    const dayStat = stats[key];
    if (!dayStat || dayStat.total === 0) return 0;
    const rate = dayStat.completed / dayStat.total;
    if (rate >= 0.9) return 4;
    if (rate >= 0.6) return 3;
    if (rate >= 0.3) return 2;
    if (rate > 0) return 1;
    return 0;
  };

  return (
    <div className="space-y-6 pt-12">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-serif italic text-xl">{format(currentMonth, 'MMMM yyyy')}</h3>
        <div className="flex gap-2">
          <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-2 opacity-50 hover:opacity-100">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-2 opacity-50 hover:opacity-100">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-2">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={`${d}-${i}`} className="text-[10px] opacity-30 text-center font-bold">{d}</div>
        ))}
        {days.map((day, i) => {
          if (!day) return <div key={`pad-${i}`} />;
          const level = getStarLevel(day);
          const isToday = isSameDay(day, new Date());
          const isSelected = isSameDay(day, selectedDate);
          const dayEntry = diaryMap[format(day, 'yyyy-MM-dd')];
          const hasDiary = dayEntry?.content.trim().length > 0;
          const moodColor = dayEntry?.moodColor;
          
          return (
            <button 
              key={day.toString()} 
              onClick={() => onSelectDate(day)}
              className="aspect-square flex flex-col items-center justify-center relative hover:bg-white/5 rounded-lg transition-colors"
            >
              {(isToday || isSelected) && (
                <div className={cn(
                  "absolute inset-0 border rounded-lg",
                  isSelected ? "border-blue-500/60 bg-blue-500/5" : "border-blue-500/20"
                )} />
              )}
              
              {isNight ? (
                <motion.div 
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className={cn(
                    "rounded-full transition-all duration-1000",
                    level === 4 && "w-3 h-3 bg-white shadow-[0_0_12px_rgba(255,255,255,0.9)]",
                    level === 3 && "w-2.5 h-2.5 bg-white/80 shadow-[0_0_8px_rgba(255,255,255,0.6)]",
                    level === 2 && "w-2 h-2 bg-white/60 shadow-[0_0_4px_rgba(255,255,255,0.4)]",
                    level === 1 && "w-1.5 h-1.5 bg-white/40",
                    level === 0 && "w-1 h-1 bg-white/10"
                  )}
                  style={moodColor ? { 
                    backgroundColor: moodColor, 
                    boxShadow: `0 0 12px ${moodColor}` 
                  } : {}}
                />
              ) : (
                <span className={cn(
                  "text-xs font-light",
                  level > 0 ? "text-blue-500 font-medium" : "opacity-40",
                  isSelected && "text-blue-600 font-bold"
                )}
                style={moodColor ? { color: moodColor } : {}}
                >
                  {format(day, 'd')}
                </span>
              )}

              {hasDiary && (
                <div className="absolute bottom-1.5 flex justify-center w-full">
                  <div className="w-1 h-1 bg-blue-400 rounded-full shadow-[0_0_8px_rgba(96,165,250,1)]" />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
