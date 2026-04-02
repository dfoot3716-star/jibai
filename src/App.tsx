/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Plus, 
  Check, 
  Calendar as CalendarIcon, 
  Users, 
  List, 
  Moon, 
  Sun,
  ChevronLeft,
  ChevronRight,
  Settings,
  Star,
  BookOpen,
  Send,
  MessageSquare
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

// --- Types ---

enum Priority {
  IMPORTANT_URGENT = 'IMPORTANT_URGENT',
  IMPORTANT_NOT_URGENT = 'IMPORTANT_NOT_URGENT',
  URGENT_NOT_IMPORTANT = 'URGENT_NOT_IMPORTANT',
  CASUAL = 'CASUAL'
}

interface Task {
  id: string;
  text: string;
  priority: Priority;
  completed: boolean;
  createdAt: number;
}

interface DiaryEntry {
  id: string;
  date: string; // YYYY-MM-DD
  content: string;
  chatHistory: { role: 'user' | 'model'; text: string }[];
}

interface DayStats {
  date: string; // YYYY-MM-DD
  completionRate: number; // 0 to 1
}

// --- Constants ---

const PRIORITY_CONFIG = {
  [Priority.IMPORTANT_URGENT]: { label: '重要紧急', color: 'bg-blue-600', dot: 'w-3 h-3 rounded-full' },
  [Priority.IMPORTANT_NOT_URGENT]: { label: '重要不急', color: 'bg-blue-400', dot: 'w-3 h-3 rounded-full opacity-70' },
  [Priority.URGENT_NOT_IMPORTANT]: { label: '紧急不重要', color: 'bg-blue-300', dot: 'w-3 h-3 rounded-full opacity-50' },
  [Priority.CASUAL]: { label: '随心', color: 'bg-blue-100', dot: 'w-3 h-3 rounded-full opacity-30' },
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
const playSound = (type: 'add' | 'complete' | 'click') => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
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

const Background = ({ time }: { time: Date }) => {
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

  return (
    <div className={cn("fixed inset-0 -z-10 bg-gradient-to-br transition-colors duration-1000", gradients[theme])}>
      {theme === 'night' && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {[...Array(50)].map((_, i) => (
            <motion.div
              key={i}
              className="absolute bg-white rounded-full"
              style={{
                width: Math.random() * 2 + 1,
                height: Math.random() * 2 + 1,
                top: `${Math.random() * 100}%`,
                left: `${Math.random() * 100}%`,
                opacity: Math.random() * 0.5 + 0.2,
              }}
              animate={{
                opacity: [0.2, 0.8, 0.2],
                scale: [1, 1.2, 1],
              }}
              transition={{
                duration: Math.random() * 3 + 2,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};


export default function App() {
  const [tasks, setTasks] = useLocalStorage<Task[]>('jibai-tasks', []);
  const [diaries, setDiaries] = useLocalStorage<DiaryEntry[]>('jibai-diaries', []);
  const [activeTab, setActiveTab] = useState<'list' | 'calendar' | 'music' | 'diary'>('list');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(startOfDay(new Date()));
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTaskText, setNewTaskText] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<Priority>(Priority.IMPORTANT_URGENT);
  const [isLoaded, setIsLoaded] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  
  // Diary State
  const [diaryContent, setDiaryContent] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  
  // Timer State
  const [timerSeconds, setTimerSeconds] = useState(25 * 60);
  const [isTimerRunning, setIsTimerRunning] = useState(false);

  useEffect(() => {
    let interval: any;
    if (isTimerRunning && timerSeconds > 0) {
      interval = setInterval(() => {
        setTimerSeconds(s => s - 1);
      }, 1000);
    } else if (timerSeconds === 0) {
      setIsTimerRunning(false);
      playSound('complete');
    }
    return () => clearInterval(interval);
  }, [isTimerRunning, timerSeconds]);

  const toggleTimer = () => {
    playSound('click');
    setIsTimerRunning(!isTimerRunning);
  };

  const resetTimer = () => {
    playSound('click');
    setIsTimerRunning(false);
    setTimerSeconds(25 * 60);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
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

  const addTask = () => {
    if (!newTaskText.trim()) return;
    const newTask: Task = {
      id: crypto.randomUUID(),
      text: newTaskText,
      priority: newTaskPriority,
      completed: false,
      createdAt: startOfDay(selectedDate).getTime() + (Date.now() % (24 * 60 * 60 * 1000)),
    };
    setTasks([...tasks, newTask]);
    setNewTaskText('');
    setShowAddModal(false);
    playSound('add');
  };

  const toggleTask = (id: string) => {
    const task = tasks.find(t => t.id === id);
    if (task && !task.completed) {
      playSound('complete');
    } else {
      playSound('click');
    }
    setTasks(tasks.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const deleteTask = (id: string) => {
    playSound('click');
    setTasks(tasks.filter(t => t.id !== id));
  };

  const filteredTasks = useMemo(() => {
    return tasks.filter(t => isSameDay(new Date(t.createdAt), selectedDate));
  }, [tasks, selectedDate]);

  const stats = useMemo(() => {
    const grouped: Record<string, { total: number; completed: number }> = {};
    tasks.forEach(t => {
      const day = format(t.createdAt, 'yyyy-MM-dd');
      if (!grouped[day]) grouped[day] = { total: 0, completed: 0 };
      grouped[day].total++;
      if (t.completed) grouped[day].completed++;
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
  }, [currentDiary]);

  const saveDiary = (content: string) => {
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    const existing = diaries.find(d => d.date === dateKey);
    if (existing) {
      setDiaries(diaries.map(d => d.date === dateKey ? { ...d, content } : d));
    } else {
      setDiaries([...diaries, { id: crypto.randomUUID(), date: dateKey, content, chatHistory: [] }]);
    }
  };

  const handleAiChat = async () => {
    if (!chatInput.trim() || isAiLoading) return;
    
    const userMsg = chatInput;
    setChatInput('');
    setIsAiLoading(true);
    
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    const entry = diaries.find(d => d.date === dateKey) || { id: crypto.randomUUID(), date: dateKey, content: diaryContent, chatHistory: [] };
    
    const newHistory = [...entry.chatHistory, { role: 'user' as const, text: userMsg }];
    
    // Update local state immediately for UI
    const updatedEntry = { ...entry, chatHistory: newHistory };
    if (diaries.find(d => d.date === dateKey)) {
      setDiaries(diaries.map(d => d.date === dateKey ? updatedEntry : d));
    } else {
      setDiaries([...diaries, updatedEntry]);
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const model = ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: newHistory.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        config: {
          systemInstruction: `你是一个温柔、富有同理心的日记助手。用户正在写关于 ${dateKey} 的日记。日记内容是：“${diaryContent}”。请根据日记内容和用户的提问，提供有深度的反馈、鼓励或建议。保持简洁、诗意且温暖。`,
        }
      });

      const response = await model;
      const aiText = response.text || "抱歉，我现在无法回应。";
      
      const finalHistory = [...newHistory, { role: 'model' as const, text: aiText }];
      setDiaries(prev => prev.map(d => d.date === dateKey ? { ...d, chatHistory: finalHistory } : d));
    } catch (error) {
      console.error("AI Chat Error:", error);
      const errorMsg = { role: 'model' as const, text: "连接星空失败，请稍后再试。" };
      setDiaries(prev => prev.map(d => d.date === dateKey ? { ...d, chatHistory: [...newHistory, errorMsg] } : d));
    } finally {
      setIsAiLoading(false);
    }
  };

  const isNight = currentTime.getHours() >= 20 || currentTime.getHours() < 5;

  if (!isLoaded) return null;

  return (
    <div className={cn("h-screen flex flex-col items-center justify-center p-4 md:p-8 overflow-hidden transition-colors duration-1000", isNight ? "text-white" : "text-slate-900")}>
      <Background time={currentTime} />

      <AnimatePresence>
        {showIntro && (
          <motion.div
            key="intro"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2, ease: [0.22, 1, 0.36, 1] }}
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
              transition={{ duration: 4, ease: "easeOut" }}
              className={cn(
                "absolute w-[150%] aspect-square rounded-full blur-[120px] -bottom-1/2",
                isNight ? "bg-gradient-to-t from-blue-400/20 via-transparent to-transparent" : "bg-gradient-to-t from-white/40 via-transparent to-transparent"
              )}
            />

            <div className="relative z-10 flex flex-col items-center">
              <motion.div
                initial={{ opacity: 0, letterSpacing: "1em", filter: "blur(10px)" }}
                animate={{ opacity: 1, letterSpacing: "0.5em", filter: "blur(0px)" }}
                transition={{ duration: 2.5, ease: [0.22, 1, 0.36, 1] }}
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
                transition={{ delay: 1.5, duration: 1.5, ease: "easeInOut" }}
                className="h-px bg-current mt-12"
              />

              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 0.4, y: 0 }}
                transition={{ delay: 2, duration: 1.5 }}
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

      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="w-full max-w-2xl flex flex-col h-full relative"
      >
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
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto px-8 py-4 custom-scrollbar">
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
                  <div className="space-y-8">
                    {Object.entries(PRIORITY_CONFIG).map(([priority, config]) => {
                      const priorityTasks = filteredTasks.filter(t => t.priority === priority);
                      if (priorityTasks.length === 0) return null;
                      
                      return (
                        <div key={priority} className="space-y-4">
                          <div className="flex items-center gap-2 opacity-30">
                            <div className={cn("w-1 h-1 rounded-full", config.color)} />
                            <p className="text-[9px] uppercase tracking-[0.2em] font-bold">{config.label}</p>
                          </div>
                          <div className="space-y-4">
                            {priorityTasks
                              .sort((a, b) => (a.completed === b.completed ? 0 : a.completed ? 1 : -1))
                              .map(task => (
                                <motion.div
                                  layout
                                  key={task.id}
                                  className={cn(
                                    "flex items-center gap-4 group transition-opacity",
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
                                  
                                  <div className="flex-1">
                                    <p className={cn(
                                      "text-lg font-light transition-all",
                                      task.completed && "line-through"
                                    )}>
                                      {task.text}
                                    </p>
                                  </div>

                                  <button 
                                    onClick={() => deleteTask(task.id)}
                                    className="opacity-0 group-hover:opacity-40 hover:opacity-100 transition-opacity"
                                  >
                                    <Plus size={14} className="rotate-45" />
                                  </button>
                                </motion.div>
                              ))}
                          </div>
                        </div>
                      );
                    })}
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
                <div className="flex-1 flex flex-col glass rounded-[2.5rem] p-8 overflow-hidden relative">
                  {!isChatting ? (
                    <>
                      <div className="flex justify-between items-center mb-6">
                        <p className="text-[10px] uppercase tracking-[0.3em] opacity-40 font-bold">每日心语</p>
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
                        className="flex-1 bg-transparent border-none focus:ring-0 p-0 text-lg font-light leading-relaxed placeholder:opacity-20 resize-none custom-scrollbar min-h-[200px]"
                        spellCheck={false}
                      />
                    </>
                  ) : (
                    <div className="flex flex-col h-full">
                      <div className="flex justify-between items-center mb-6">
                        <p className="text-[10px] uppercase tracking-[0.3em] opacity-40 font-bold">星空对话</p>
                        <button 
                          onClick={() => setIsChatting(false)}
                          className="p-2 glass rounded-full opacity-60 hover:opacity-100 transition-opacity"
                        >
                          <ChevronLeft size={18} />
                        </button>
                      </div>
                      
                      <div className="flex-1 overflow-y-auto space-y-4 mb-4 custom-scrollbar pr-2">
                        {currentDiary.chatHistory.length === 0 && (
                          <div className="h-full flex items-center justify-center opacity-20 text-center px-8">
                            <p className="text-sm italic">“在这里，你可以和我聊聊今天的感悟。”</p>
                          </div>
                        )}
                        {currentDiary.chatHistory.map((msg, i) => (
                          <div key={i} className={cn(
                            "max-w-[85%] p-4 rounded-3xl text-sm leading-relaxed",
                            msg.role === 'user' 
                              ? "ml-auto bg-blue-500/20 text-blue-200 rounded-tr-none" 
                              : "mr-auto glass text-white/80 rounded-tl-none"
                          )}>
                            {msg.text}
                          </div>
                        ))}
                        {isAiLoading && (
                          <div className="mr-auto glass p-4 rounded-3xl rounded-tl-none flex gap-1">
                            <motion.div animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1 h-1 bg-white rounded-full" />
                            <motion.div animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1 h-1 bg-white rounded-full" />
                            <motion.div animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1 h-1 bg-white rounded-full" />
                          </div>
                        )}
                      </div>

                      <div className="relative">
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleAiChat()}
                          placeholder="向星空提问..."
                          className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-4 pr-12 text-sm focus:ring-1 focus:ring-blue-500/50 outline-none"
                        />
                        <button 
                          onClick={handleAiChat}
                          disabled={isAiLoading}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-20"
                        >
                          <Send size={18} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {activeTab === 'music' && (
              <motion.div
                key="music"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex flex-col items-center justify-center h-full text-center"
              >
                {/* Timer Section */}
                <div className="space-y-12">
                  <div className="relative inline-block">
                    <svg className="w-64 h-64 -rotate-90">
                      <circle 
                        cx="128" cy="128" r="118" 
                        className="stroke-white/10 fill-none" 
                        strokeWidth="1.5" 
                      />
                      <motion.circle 
                        cx="128" cy="128" r="118" 
                        className="stroke-blue-500 fill-none" 
                        strokeWidth="3" 
                        strokeLinecap="round"
                        initial={{ pathLength: 1 }}
                        animate={{ pathLength: timerSeconds / (25 * 60) }}
                        transition={{ duration: 1, ease: "linear" }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-7xl font-light tracking-tighter">{formatTime(timerSeconds)}</span>
                      <p className="text-[10px] uppercase tracking-[0.3em] opacity-40 mt-4">专注时刻</p>
                    </div>
                  </div>
                  
                  <div className="flex justify-center gap-6">
                    <button 
                      onClick={toggleTimer}
                      className="px-12 py-4 glass rounded-full text-sm tracking-widest uppercase font-medium hover:bg-white/10 transition-all active:scale-95"
                    >
                      {isTimerRunning ? "暂停" : "开始"}
                    </button>
                    <button 
                      onClick={resetTimer}
                      className="px-12 py-4 glass rounded-full text-sm tracking-widest uppercase font-medium hover:bg-white/10 transition-all active:scale-95"
                    >
                      重置
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Navigation */}
        <nav className="p-6 flex justify-around border-t border-white/10 shrink-0">
          <NavButton active={activeTab === 'list'} onClick={() => { playSound('click'); setActiveTab('list'); }} icon={<List size={20} />} />
          <NavButton active={activeTab === 'calendar'} onClick={() => { playSound('click'); setActiveTab('calendar'); }} icon={<CalendarIcon size={20} />} />
          <NavButton active={activeTab === 'diary'} onClick={() => { playSound('click'); setActiveTab('diary'); }} icon={<BookOpen size={20} />} />
          <NavButton active={activeTab === 'music'} onClick={() => { playSound('click'); setActiveTab('music'); }} icon={<Moon size={20} />} />
        </nav>

        {/* Add Modal */}
        <AnimatePresence>
          {showAddModal && (
            <motion.div 
              initial={{ opacity: 0, scale: 1.05 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              className={cn(
              "fixed inset-0 z-[60] glass backdrop-blur-2xl flex flex-col p-6 md:p-10 overflow-y-auto",
              "pb-[safe-area-inset-bottom]"
            )}
            >
              <div className="flex justify-between items-center mb-16">
                <h2 className="text-3xl font-serif italic">新计划</h2>
                <button 
                  onClick={() => {
                    playSound('click');
                    setShowAddModal(false);
                  }} 
                  className="p-2 opacity-40 hover:opacity-100 transition-opacity"
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
                  className="bg-transparent border-none text-3xl font-light focus:ring-0 placeholder:opacity-20 w-full p-0"
                  onKeyDown={(e) => e.key === 'Enter' && addTask()}
                />

                <div className="space-y-4">
                  <p className="text-[10px] opacity-30 uppercase tracking-[0.3em] font-bold">优先级</p>
                  <div className="grid grid-cols-2 gap-3 md:gap-4">
                    {Object.entries(PRIORITY_CONFIG).map(([key, config]) => (
                      <button
                        key={key}
                        onClick={() => {
                          playSound('click');
                          setNewTaskPriority(key as Priority);
                        }}
                        className={cn(
                          "flex items-center gap-2 md:gap-4 p-3 md:p-5 rounded-2xl md:rounded-3xl border transition-all duration-300",
                          newTaskPriority === key 
                            ? "bg-blue-500 text-white border-blue-500 shadow-xl shadow-blue-500/20 scale-[1.02]" 
                            : "bg-white/5 border-white/10 opacity-40 hover:opacity-100"
                        )}
                      >
                        <div className={cn(config.dot, "shrink-0", newTaskPriority === key ? "bg-white" : config.color)} />
                        <span className="text-xs md:text-sm tracking-wide whitespace-nowrap">{config.label}</span>
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
      </motion.div>

    </div>
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
          const hasDiary = diaryMap[format(day, 'yyyy-MM-dd')]?.content.trim().length > 0;
          
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
                />
              ) : (
                <span className={cn(
                  "text-xs font-light",
                  level > 0 ? "text-blue-500 font-medium" : "opacity-40",
                  isSelected && "text-blue-600 font-bold"
                )}>
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
