import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  FileVideo, 
  FileAudio, 
  Upload, 
  History, 
  LayoutDashboard, 
  LogOut, 
  Settings, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  FileText,
  Languages,
  Download,
  Share2,
  Play,
  Pause,
  ChevronRight,
  ChevronLeft,
  Menu,
  X,
  Sparkles,
  Zap,
  Trash2
} from 'lucide-react';
import { auth, completeGoogleRedirectSignIn, db, signInWithGoogle, logout, storage } from './lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, orderBy, onSnapshot, addDoc, doc, updateDoc, deleteDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { cn, formatDuration, formatDate } from './lib/utils';
import { processMediaInBrowser, translateText, summarizeTranscript } from './services/gemini';
import Markdown from 'react-markdown';

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // Supports long compressed audio/video uploads without browser base64 conversion.
const AI_PROCESSING_TIMEOUT_MS = 60 * 60 * 1000;
const isVercelRuntime = window.location.hostname.endsWith('.vercel.app');

const formatFileSize = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

// --- Error Handling ---
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
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const err = error as any;
  if (err?.code === 'permission-denied' || (error instanceof Error && error.message.includes('permission'))) {
    const errInfo: FirestoreErrorInfo = {
      error: error instanceof Error ? error.message : String(error),
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
        isAnonymous: auth.currentUser?.isAnonymous,
        tenantId: auth.currentUser?.tenantId,
        providerInfo: auth.currentUser?.providerData?.map(provider => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || []
      },
      operationType,
      path
    };
    console.error('Firestore Error: ', JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  }
  throw error;
}

// --- Types ---
type Page = 'landing' | 'dashboard' | 'transcript' | 'settings';

interface Transcript {
  id: string;
  userId: string;
  fileName: string;
  fileType: string;
  fileUrl: string;
  status: 'processing' | 'completed' | 'failed';
  text?: string;
  srt?: string;
  summary?: string;
  summaryPoints?: string[];
  keyTakeaways?: string[];
  language?: string;
  processingStep?: string;
  createdAt: any;
  updatedAt?: any;
}

// --- Components ---

const Button = ({ 
  children, 
  className, 
  variant = 'primary', 
  size = 'md',
  ...props 
}: any) => {
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-500/20 active:bg-indigo-800',
    secondary: 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 active:bg-slate-600',
    ghost: 'bg-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50',
    danger: 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 active:bg-red-500/30'
  };
  const sizes = {
    sm: 'px-3 py-1.5 text-[11px] font-bold uppercase tracking-tight',
    md: 'px-4 py-2 text-sm font-medium',
    lg: 'px-6 py-3 text-base font-semibold'
  };

  return (
    <button 
      className={cn(
        'inline-flex items-center justify-center rounded-lg transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed active:scale-95',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};

const GlassCard = ({ children, className }: { children: React.ReactNode, className?: string }) => (
  <div className={cn("bg-slate-900/40 backdrop-blur-md border border-slate-800 rounded-2xl shadow-xl", className)}>
    {children}
  </div>
);

// --- App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>('landing');
  const [loading, setLoading] = useState(true);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [selectedTranscriptId, setSelectedTranscriptId] = useState<string | null>(null);
  const selectedTranscript = transcripts.find(t => t.id === selectedTranscriptId) || null;
  const [translations, setTranslations] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fakeProgress, setFakeProgress] = useState(0);
  const [summarizing, setSummarizing] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [viewLanguage, setViewLanguage] = useState<string>('original');
  const [agentInstruction, setAgentInstruction] = useState('');
  const [userGeminiApiKey, setUserGeminiApiKey] = useState(() => localStorage.getItem('dg_gemini_api_key') || '');

  useEffect(() => {
    if (!selectedTranscript) {
      setTranslations([]);
      setViewLanguage('original');
      return;
    }
    const q = query(
      collection(db, 'transcripts', selectedTranscript.id, 'translations'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setTranslations(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    });
    return () => unsubscribe();
  }, [selectedTranscript]);

  useEffect(() => {
    let interval: any;
    if (uploading || (selectedTranscript && selectedTranscript.status === 'processing')) {
      setFakeProgress(0);
      interval = setInterval(() => {
        setFakeProgress(prev => {
          if (prev >= 96) {
            // Hold below completion until the server returns the real result.
            const remaining = 97 - prev;
            return prev + (remaining * 0.01); 
          }
          // Dynamic speed based on progress
          const increment = prev < 60 ? 12 : prev < 90 ? 3 : 0.7;
          return Math.min(96, prev + increment);
        });
      }, 120);
    } else {
      setFakeProgress(0);
      if (interval) clearInterval(interval);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [uploading, selectedTranscript?.status]);

  useEffect(() => {
    completeGoogleRedirectSignIn().catch((error) => {
      console.error("Google redirect sign-in failed:", error);
      const code = (error as { code?: string })?.code;

      if (code === 'auth/unauthorized-domain') {
        setAuthError('Google Sign In is blocked because localhost is not authorized in Firebase Authentication settings.');
        return;
      }

      setAuthError(error instanceof Error ? error.message : 'Google Sign In failed. Please try again.');
    });

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        setCurrentPage('dashboard');
      } else {
        setCurrentPage('landing');
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'transcripts'), 
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Transcript));
      setTranscripts(data);
      
      // Removed auto-selection to allow user to see the welcome screen
    });
    return () => unsubscribe();
  }, [user]);

  const handleFileUpload = async (file: File) => {
    if (!user) return;

    setUploadError(null);
    const userApiKey = localStorage.getItem('dg_gemini_api_key') || '';

    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
      setUploadError('Please upload an audio or video file.');
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`This file is ${formatFileSize(file.size)}. Please upload a file up to ${formatFileSize(MAX_UPLOAD_BYTES)} for 1-3 hour audio or video.`);
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      setUploadProgress(2);

      // 1. Create Firestore record immediately
      let docRef;
      try {
        docRef = await addDoc(collection(db, 'transcripts'), {
          userId: user.uid,
          fileName: file.name,
          fileType: file.type,
          fileUrl: "",
          status: 'processing',
          processingStep: 'Preparing long media upload...',
          createdAt: serverTimestamp()
        });

        // Select immediately and update list optimistically so UI shows progress
        const optimisticTranscript = {
          id: docRef.id,
          userId: user.uid,
          fileName: file.name,
          fileType: file.type,
          fileUrl: "",
          status: 'processing',
          processingStep: 'Preparing long media upload...',
          createdAt: { toDate: () => new Date() } // temporary mock
        } as Transcript;

        setTranscripts(prev => [optimisticTranscript, ...prev]);
        setSelectedTranscriptId(docRef.id);
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, 'transcripts');
        setUploading(false);
        return;
      }

      // 2. Start AI Processing NOW in parallel without converting long media to base64
      void processFile(docRef.id, file);

      // 3. Storage upload in background
      const storageRef = ref(storage, `users/${user.uid}/${Date.now()}_${file.name}`);
      const uploadTask = uploadBytesResumable(storageRef, file);

      uploadTask.on('state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          setUploadProgress(Math.round(progress));
        },
        (error) => {
          console.warn("Storage upload failed:", error);
          setUploadError("Storage upload failed. Please check your connection and try again.");
          setUploading(false);
        },
        async () => {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          try {
            await updateDoc(doc(db, 'transcripts', docRef.id), {
              fileUrl: downloadURL
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.UPDATE, `transcripts/${docRef.id}`);
          }
          setUploading(false);
        }
      );
    } catch (error) {
      console.error(error);
      setUploadError("Upload failed. Please try a smaller or more compressed file.");
      setUploading(false);
    }
  };

  const processFile = async (id: string, file: File) => {
    let stepInterval: ReturnType<typeof setInterval> | null = null;

    try {
      try {
        await updateDoc(doc(db, 'transcripts', id), {
          processingStep: 'Turbo AI: Real-time neural processing...'
        });
        
        // Faster UI updates to show life
        const steps = [
          'Turbo AI: Uploading long media to Gemini...',
          'Turbo AI: Preparing 1-3 hour media file...',
          'Turbo AI: Scanning voice frequencies...',
          'Turbo AI: Synchronizing neural networks...',
          'Turbo AI: Identifying speaker patterns...',
          'Turbo AI: Khmer-English script mapping...',
          'Turbo AI: Optimizing semantic structure...',
          'Turbo AI: Finalizing verbatim layout...',
          'Turbo AI: Polishing transcript structure...'
        ];
        
        let stepIdx = 0;
        stepInterval = setInterval(async () => {
          if (stepIdx < steps.length) {
            try {
              await updateDoc(doc(db, 'transcripts', id), {
                processingStep: steps[stepIdx]
              });
              stepIdx++;
            } catch (e) {
              clearInterval(stepInterval);
            }
          } else {
            clearInterval(stepInterval);
          }
        }, 900);

        const formData = new FormData();
        formData.append('media', file);
        const userApiKey = localStorage.getItem('dg_gemini_api_key') || '';

        // Vercel serverless functions are not reliable for large media uploads.
        // In production, users with a personal key upload directly to Gemini from the browser.
        const aiProcessingPromise = isVercelRuntime && userApiKey
          ? processMediaInBrowser(file, userApiKey)
          : fetch('/api/transcribe', {
              method: 'POST',
              headers: userApiKey ? { 'X-Gemini-Api-Key': userApiKey } : undefined,
              body: formData,
            }).then(async response => {
              const payload = await response.json().catch(() => ({}));

              if (!response.ok) {
                throw new Error(payload.error || 'AI transcription failed.');
              }

              return payload;
            });
        
        // Safety timeout: long media can take a while to transcribe.
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("AI transformation took too long. Please try compressing the file or splitting it into smaller parts.")), AI_PROCESSING_TIMEOUT_MS)
        );

        const aiResult = (await Promise.race([aiProcessingPromise, timeoutPromise])) as any;
        if (stepInterval) {
          clearInterval(stepInterval);
          stepInterval = null;
        }

        // Update local state optimistically
        setTranscripts(prev => prev.map(t => t.id === id ? {
          ...t,
          status: 'completed',
          processingStep: 'Transformation Complete!',
          text: aiResult.text,
          language: aiResult.language,
          summary: aiResult.summary,
          summaryPoints: aiResult.points,
          keyTakeaways: aiResult.takeaways,
        } : t));

        await updateDoc(doc(db, 'transcripts', id), {
          status: 'completed',
          processingStep: 'Transformation Complete!',
          text: aiResult.text,
          language: aiResult.language,
          summary: aiResult.summary,
          summaryPoints: aiResult.points,
          keyTakeaways: aiResult.takeaways,
          updatedAt: serverTimestamp()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `transcripts/${id}`);
      }
    } catch (error) {
      if (stepInterval) {
        clearInterval(stepInterval);
      }
      console.error("AI Processing error:", error);
      const errorMessage = error instanceof Error ? error.message : 'AI could not finish this long file.';
      setTranscripts(prev => prev.map(t => t.id === id ? {
        ...t,
        status: 'failed',
        processingStep: errorMessage,
      } : t));
      setUploading(false);
      try {
        await updateDoc(doc(db, 'transcripts', id), {
          status: 'failed',
          processingStep: errorMessage,
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        console.error("Failed to update status to failed:", e);
      }
    }
  };

  const handleExportPdf = async (transcript: Transcript) => {
    try {
      const response = await fetch('/api/export/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: transcript.fileName,
          content: transcript.text
        })
      });
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${transcript.fileName.split('.')[0]}.pdf`;
      a.click();
    } catch (error) {
      console.error(error);
    }
  };

  const handleTranslate = async (transcript: Transcript, lang: string, forceRefresh = false) => {
    if (!transcript.text) return;
    
    // Check if translation already exists locally
    const existing = translations.find(t => t.targetLanguage === lang);
    if (existing && !forceRefresh) {
      setViewLanguage(lang);
      return;
    }

    setTranslating(true);
    try {
      setUploadError(null);
      setViewLanguage(lang);
      const res = await translateText(transcript.text, lang);
      try {
        await addDoc(collection(db, 'transcripts', transcript.id, 'translations'), {
          userId: user?.uid,
          transcriptId: transcript.id,
          targetLanguage: lang,
          translatedText: res.translatedText,
          createdAt: serverTimestamp()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, `transcripts/${transcript.id}/translations`);
      }
    } catch (error) {
      console.error(error);
      setUploadError(error instanceof Error ? error.message : 'Translation failed. Please try again.');
    } finally {
      setTranslating(false);
    }
  };

  const handleResummarize = async (transcript: Transcript, instruction: string = "") => {
    if (!transcript.text) return;
    setSummarizing(true);
    try {
      setUploadError(null);
      const result = await summarizeTranscript(transcript.text, transcript.language || "original", instruction);
      try {
        await updateDoc(doc(db, 'transcripts', transcript.id), {
          summary: result.summary,
          summaryPoints: result.points,
          keyTakeaways: result.takeaways,
          updatedAt: serverTimestamp()
        });
        setAgentInstruction('');
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `transcripts/${transcript.id}`);
      }
    } catch (error) {
      console.error("Resummarize failed:", error);
      setUploadError(error instanceof Error ? error.message : 'Summary failed. Please try again.');
    } finally {
      setSummarizing(false);
    }
  };

  const [deleteConfirming, setDeleteConfirming] = useState<string | null>(null);

  const handleDeleteTranscript = async (id: string, e: React.MouseEvent) => {
    if (!user) return;
    e.stopPropagation();
    e.preventDefault();
    
    if (deleteConfirming !== id) {
      setDeleteConfirming(id);
      // Reset after 3 seconds if not clicked again
      setTimeout(() => setDeleteConfirming(null), 3000);
      return;
    }
    
    try {
      setDeleteConfirming(null);
      // Optimistic delete: remove from local state first
      setTranscripts(prev => prev.filter(t => t.id !== id));
      
      // Delete associated translations first
      const translationsRef = collection(db, 'transcripts', id, 'translations');
      const translationsSnap = await getDocs(query(translationsRef, where('userId', '==', user.uid)));
      const deletePromises = translationsSnap.docs.map(d => deleteDoc(d.ref));
      await Promise.all(deletePromises);

      // Delete the main transcript document
      await deleteDoc(doc(db, 'transcripts', id));
      
      if (selectedTranscriptId === id) {
        setSelectedTranscriptId(null);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `transcripts/${id}`);
    }
  };

  const handleSignIn = async () => {
    setAuthError(null);

    try {
      await signInWithGoogle();
    } catch (error) {
      console.error("Google sign-in failed:", error);
      const code = (error as { code?: string })?.code;

      if (code === 'auth/unauthorized-domain') {
        setAuthError('Google Sign In is blocked because localhost:3001 is not authorized in Firebase Authentication settings.');
        return;
      }

      if (code === 'auth/popup-closed-by-user') {
        setAuthError('The Google sign-in window was closed before login finished. Please try again.');
        return;
      }

      setAuthError(error instanceof Error ? error.message : 'Google Sign In failed. Please try again.');
    }
  };

  const handleSaveGeminiApiKey = () => {
    const key = userGeminiApiKey.trim();

    if (key) {
      localStorage.setItem('dg_gemini_api_key', key);
      setUploadError('Gemini API key saved for this browser. Upload again to use your own quota.');
      return;
    }

    localStorage.removeItem('dg_gemini_api_key');
    setUploadError('Personal Gemini API key cleared. The app will use the server key pool.');
  };

  if (loading) return (
    <div className="min-h-screen bg-[#09090B] flex items-center justify-center">
      <Sparkles className="w-12 h-12 text-indigo-500 animate-pulse" />
    </div>
  );

  if (currentPage === 'landing' || !user) {
    return (
      <div className="min-h-screen bg-[#09090B] text-slate-200 selection:bg-indigo-500/30 font-sans overflow-x-hidden">
        <nav className="fixed top-0 left-0 right-0 z-50 px-8 py-4 border-b border-slate-800 backdrop-blur-md bg-black/20">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
                <Zap className="w-5 h-5 text-white fill-white" />
              </div>
              <span className="text-xl font-bold tracking-tight text-white">DG Transcribe <span className="text-indigo-400">AI</span></span>
            </div>
            <Button size="sm" onClick={handleSignIn}>Sign In</Button>
          </div>
        </nav>

        <main className="pt-32 pb-20 px-8">
          <div className="max-w-7xl mx-auto text-center">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[11px] font-bold uppercase tracking-widest mx-auto">
                <Sparkles className="w-4 h-4" />
                Next Generation Transcription
              </div>
              <h1 className="text-6xl md:text-8xl font-bold tracking-tighter text-white leading-[0.9]">
                Voice to <span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-indigo-400 bg-clip-text text-transparent animate-gradient-x">Insights</span>
              </h1>
              <p className="text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
                Experience high-fidelity transcription powered by Gemini 1.5 Flash. Summarize meetings, extract action items, and translate instantly.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
                <Button size="lg" onClick={handleSignIn} className="group">
                  Start Transcribing <ChevronRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                </Button>
                <Button variant="secondary" size="lg">Watch Demo</Button>
              </div>
              {authError && (
                <div className="max-w-xl mx-auto rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-200 flex items-start gap-3 text-left">
                  <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
              )}

              {/* Visual Mockup */}
              <div className="mt-24 relative max-w-5xl mx-auto">
                <div className="absolute inset-0 bg-indigo-600/20 blur-[100px] rounded-full transform -translate-y-1/2 scale-150 pointer-events-none" />
                <div className="relative bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
                  <div className="h-10 bg-slate-950 border-b border-slate-800 flex items-center px-4 gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/20 border border-red-500/40" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20 border border-yellow-500/40" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/20 border border-green-500/40" />
                  </div>
                  <div className="p-8 grid grid-cols-2 gap-8 text-left h-[400px]">
                    <div className="space-y-4">
                       <div className="h-4 bg-slate-800 rounded-full w-3/4 animate-pulse" />
                       <div className="h-4 bg-slate-800 rounded-full w-1/2 animate-pulse" />
                       <div className="h-4 bg-slate-800 rounded-full w-5/6 animate-pulse" />
                       <div className="h-4 bg-slate-800 rounded-full w-2/3 animate-pulse" />
                    </div>
                    <div className="space-y-6">
                       <div className="bg-indigo-600/10 border border-indigo-500/20 rounded-xl p-4">
                          <div className="h-3 bg-indigo-400/20 rounded-full w-1/4 mb-3" />
                          <div className="h-2 bg-indigo-400/10 rounded-full w-full mb-2" />
                          <div className="h-2 bg-indigo-400/10 rounded-full w-5/6" />
                       </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#09090B] text-slate-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800 bg-[#0C0C0E] flex flex-col shrink-0">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Zap className="w-5 h-5 text-white fill-white" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">DG Transcribe <span className="text-indigo-400">AI</span></span>
        </div>
        
        <nav className="flex-1 px-4 space-y-1 py-4">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold px-3 mb-4">Core Actions</div>
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 font-medium text-sm text-left">
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </button>
          
          <div className="mt-8">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold px-3 mb-4">Your Library</div>
            <div className="space-y-1 max-h-[300px] overflow-y-auto px-2 scrollbar-thin scrollbar-thumb-slate-800">
               {transcripts.map(t => (
                 <div key={t.id} className="group relative flex items-center">
                   <button 
                    onClick={() => setSelectedTranscriptId(t.id)}
                    className={cn(
                      "flex-1 flex items-center gap-3 px-3 py-2 rounded-lg text-xs transition-colors text-left truncate pr-10",
                      selectedTranscriptId === t.id 
                        ? "bg-slate-800 text-white font-medium" 
                        : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                    )}
                   >
                     {t.fileType.startsWith('video') ? <FileVideo className="w-3.5 h-3.5 shrink-0" /> : <FileAudio className="w-3.5 h-3.5 shrink-0" />}
                     <span className="truncate">{t.fileName}</span>
                   </button>
                   <button 
                    type="button"
                    onClick={(e) => handleDeleteTranscript(t.id, e)}
                    className={cn(
                      "absolute right-1.5 p-1.5 transition-all z-50 rounded-md flex items-center gap-1.5 shadow-sm",
                      deleteConfirming === t.id 
                        ? "bg-red-500 text-white scale-105 opacity-100" 
                        : (selectedTranscriptId === t.id 
                            ? "opacity-100 text-slate-400 hover:text-red-400 hover:bg-slate-700" 
                            : "opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 hover:bg-slate-800")
                    )}
                    title={deleteConfirming === t.id ? "Click again to confirm" : "Delete"}
                   >
                    {deleteConfirming === t.id && <span className="text-[9px] font-bold uppercase tracking-tighter">លុប?</span>}
                    <Trash2 className="w-3.5 h-3.5" />
                   </button>
                 </div>
               ))}
            </div>
          </div>
        </nav>

        <div className="p-4 border-t border-slate-800">
          <div className="bg-slate-900/50 border border-slate-800 p-4 rounded-xl">
            <div className="flex justify-between items-end mb-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Usage</span>
              <span className="text-[10px] font-bold text-white tracking-widest uppercase">8 / 10 hrs</span>
            </div>
            <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
              <div className="bg-indigo-500 h-full rounded-full" style={{ width: '80%' }}></div>
            </div>
            <button className="w-full mt-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-bold uppercase tracking-widest rounded-lg transition-colors border border-slate-700">
              Upgrade
            </button>
          </div>
        </div>

        <div className="p-4 flex items-center gap-3 border-t border-slate-800 bg-slate-950/20">
           <img src={user.photoURL || ''} alt="" className="w-8 h-8 rounded-full border border-slate-700" />
           <div className="flex-1 min-w-0">
             <p className="text-xs font-bold text-white truncate">{user.displayName}</p>
             <p className="text-[10px] text-slate-500 truncate">{user.email}</p>
           </div>
           <button onClick={logout} className="text-slate-500 hover:text-red-400 transition-colors">
              <LogOut className="w-4 h-4" />
           </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Top Header */}
        <header className="h-16 border-b border-slate-800 px-8 flex items-center justify-between bg-[#09090B]">
          <div className="flex items-center gap-2 text-xs font-medium">
            {selectedTranscriptId && (
              <button 
                onClick={() => setSelectedTranscriptId(null)}
                className="flex items-center gap-1 px-2 py-1 bg-slate-800/50 hover:bg-slate-800 text-slate-400 hover:text-white rounded-md transition-all mr-2 group"
              >
                <ChevronLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
                <span className="font-bold uppercase tracking-tighter text-[10px]">ត្រឡប់ក្រោយ</span>
              </button>
            )}
            <span className="text-slate-500 uppercase tracking-widest font-bold flex items-center gap-2">
              Dashboard
              <span className="flex items-center gap-1 bg-green-500/10 text-green-500 px-1.5 py-0.5 rounded text-[8px] animate-pulse">
                <Zap className="w-2.5 h-2.5 fill-green-500" />
                HIGH-SPEED AI
              </span>
            </span>
            <ChevronRight className="w-4 h-4 text-slate-700" />
            <span className="text-slate-200 uppercase tracking-widest font-bold truncate max-w-[200px]">
              {selectedTranscript ? selectedTranscript.fileName : 'New Transcription'}
            </span>
          </div>
          
          <div className="flex items-center gap-4">
            <input 
              type="file" 
              id="file-upload" 
              className="hidden" 
              accept="audio/*,video/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
                e.currentTarget.value = '';
              }}
            />
            <label htmlFor="file-upload">
              <span className="cursor-pointer inline-flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest shadow-lg shadow-indigo-500/20 hover:bg-indigo-700 transition-colors active:scale-95">
                <Upload className="w-4 h-4" />
                Upload
              </span>
            </label>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8 bg-gradient-to-b from-[#09090B] to-[#0D0D0F]">
          {uploadError && (
            <div className="max-w-8xl mx-auto mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-200 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <span>{uploadError}</span>
            </div>
          )}

          <div className="max-w-8xl mx-auto mb-8">
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-1"
            >
              <h1 className="text-2xl font-bold text-white">សួស្ដី {user?.displayName?.split(' ')[0]}</h1>
              <p className="text-slate-400 text-sm">តើយើងគួរចាប់ផ្ដើមពីណា?</p>
            </motion.div>
          </div>

          <div className="grid grid-cols-12 gap-8 max-w-8xl mx-auto">
            
            {/* Left: Setup & Context */}
            <div className="col-span-12 lg:col-span-4 space-y-6">
               <section className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 backdrop-blur-md">
                 <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
                   <FileText className="w-4 h-4 text-indigo-500" />
                   Quick Config
                 </h3>
                 
                 <div className="space-y-4">
                   <div>
                     <label className="text-[10px] uppercase tracking-widest text-slate-600 font-bold block mb-2 px-1">Target Language</label>
                     <div className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 flex justify-between items-center text-sm group cursor-pointer hover:border-slate-700 transition-colors">
                       <span className="text-slate-400 group-hover:text-slate-200">Khmer (Cambodia)</span>
                       <ChevronRight className="w-4 h-4 text-slate-700" />
                     </div>
                   </div>

                   <div>
                     <label className="text-[10px] uppercase tracking-widest text-slate-600 font-bold block mb-2 px-1">Personal Gemini API Key</label>
                     <div className="flex gap-2">
                       <input
                         type="password"
                         value={userGeminiApiKey}
                         onChange={(e) => setUserGeminiApiKey(e.target.value)}
                         placeholder="Paste your own key"
                         className="min-w-0 flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-slate-700 focus:border-indigo-500/50 outline-none transition-all"
                       />
                       <Button variant="secondary" size="sm" onClick={handleSaveGeminiApiKey}>
                         Save
                       </Button>
                     </div>
                   </div>
                   
                   <div className="pt-2">
                      <Button variant="secondary" className="w-full justify-between group" size="sm">
                        Smart Meeting Notes
                        <Zap className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500 opacity-50 group-hover:opacity-100 transition-opacity" />
                      </Button>
                   </div>
                 </div>
               </section>

               <section className="bg-indigo-600/5 border border-indigo-500/20 rounded-2xl p-6 border-l-4 border-l-indigo-600">
                  <h4 className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-2 mb-2">
                    <Sparkles className="w-3.5 h-3.5" />
                    AI Optimization Active
                  </h4>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Whisper v3 Multi-Speaker detection and GPT-4o Insight extraction are actively processing your data.
                  </p>
               </section>

               {/* Activity Bar Replacement */}
               <div className="pt-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-[9px] uppercase font-bold tracking-wider text-slate-600 bg-slate-950/40 p-2 rounded-lg border border-slate-800/50">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]" />
                    Whisper V3 Online
                  </div>
                  <div className="flex items-center gap-2 text-[9px] uppercase font-bold tracking-wider text-slate-600 bg-slate-950/40 p-2 rounded-lg border border-slate-800/50">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]" />
                    Up to 2GB / 1-3 Hour Media
                  </div>
               </div>
            </div>

            {/* Right: Output */}
            <div className="col-span-12 lg:col-span-8">
               {selectedTranscript?.status === 'failed' ? (
                 <GlassCard className="overflow-hidden border-red-500/30 flex flex-col min-h-[420px]">
                    <div className="p-8 flex items-center gap-6 border-b border-slate-800 bg-red-950/10">
                       <div className="w-14 h-14 bg-red-500/10 rounded-xl flex items-center justify-center border border-red-500/30 text-red-400">
                         <AlertCircle className="w-7 h-7" />
                       </div>
                       <div className="flex-1">
                          <h2 className="text-sm font-bold text-white uppercase tracking-tight mb-2">
                            {selectedTranscript.fileName}
                          </h2>
                          <p className="text-[11px] text-red-300 font-bold uppercase tracking-widest">
                            Transcription stopped
                          </p>
                       </div>
                    </div>
                    <div className="flex-1 p-8 bg-slate-900/60 flex flex-col items-center justify-center text-center space-y-5">
                       <AlertCircle className="w-12 h-12 text-red-400" />
                       <div className="max-w-lg">
                          <p className="text-sm font-bold text-white mb-2">{selectedTranscript.processingStep || 'AI could not finish this file.'}</p>
                          <p className="text-xs text-slate-500 leading-relaxed font-medium">
                            Try uploading a compressed audio file, or split very long media into smaller parts for faster transcription.
                          </p>
                       </div>
                       <label htmlFor="file-upload" className="cursor-pointer inline-flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest shadow-lg shadow-indigo-500/20 hover:bg-indigo-700 transition-colors active:scale-95">
                         <Upload className="w-4 h-4" />
                         Upload Again
                       </label>
                    </div>
                 </GlassCard>
               ) : (uploading || (selectedTranscript && selectedTranscript.status === 'processing')) && selectedTranscript?.status !== 'completed' ? (
                 <GlassCard className="overflow-hidden border-indigo-500/30 flex flex-col min-h-[500px]">
                    <div className="p-8 flex items-center gap-6 border-b border-slate-800 bg-slate-950/40">
                       <div className="w-14 h-14 bg-indigo-500/20 rounded-xl flex items-center justify-center border border-indigo-500/30 text-indigo-400 font-mono font-bold animate-pulse">
                         AI
                       </div>
                       <div className="flex-1">
                          <h2 className="text-sm font-bold text-white uppercase tracking-tight mb-2">
                            {uploading ? 'Syncing with AI...' : (selectedTranscript?.fileName || 'System AI')}
                          </h2>
                          <div className="flex items-center gap-2">
                             <div className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                             <p className="text-[11px] text-indigo-400 font-bold uppercase tracking-widest">
                               {selectedTranscript?.status === 'processing'
                                 ? `Turbo AI Transcribing - ${Math.round(fakeProgress)}%` 
                                 : (uploading ? `Cloud Storage Upload - ${uploadProgress}%` : 'Finalizing Data...')}
                             </p>
                          </div>
                       </div>
                    </div>
                    
                    <div className="flex-1 p-8 bg-slate-900/60 flex flex-col items-center justify-center text-center space-y-6">
                       <div className="relative">
                          <div className="absolute inset-0 bg-indigo-600/20 blur-2xl rounded-full" />
                          <div className="w-20 h-20 border-4 border-indigo-500/10 border-t-indigo-500 rounded-full animate-spin relative shadow-[0_0_20px_rgba(99,102,241,0.3)]" />
                       </div>
                       <div className="max-w-xs">
                          <p className="text-sm font-bold text-white mb-2 animate-pulse">{selectedTranscript?.processingStep || (uploading ? "Uploading to secure cloud..." : "AI Transformation Active...")}</p>
                          <p className="text-xs text-slate-500 leading-relaxed font-medium">
                            {fakeProgress > 95 ? "Fast mode is waiting for Gemini to return the final transcript." : "Server-side fast mode is active for long audio and video transcription."}
                          </p>
                       </div>
                    </div>

                    <div className="h-1.5 bg-slate-800 w-full overflow-hidden">
                       <motion.div 
                        className="h-full bg-gradient-to-r from-indigo-600 via-purple-500 to-indigo-600 shadow-[0_0_15px_rgba(79,70,229,0.6)]" 
                        initial={{ width: '0%' }}
                        animate={{ width: `${selectedTranscript?.status === 'processing' ? fakeProgress : (uploading ? uploadProgress : 100)}%` }}
                        transition={{ type: "spring", stiffness: 50 }}
                       />
                    </div>
                 </GlassCard>
               ) : selectedTranscript ? (
                 <GlassCard className="overflow-hidden flex flex-col shadow-2xl">
                    <header className="p-6 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-slate-950/40">
                       <div className="flex items-center gap-4">
                          <div className="w-10 h-10 bg-slate-800 rounded-lg flex items-center justify-center border border-slate-700 text-slate-500 font-mono text-xs font-bold">
                            {selectedTranscript.fileType.includes('pdf') ? 'PDF' : 'DATA'}
                          </div>
                          <div>
                            <h2 className="text-sm font-bold text-white uppercase tracking-tight mb-1">{selectedTranscript.fileName}</h2>
                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest flex items-center gap-2">
                               <CheckCircle2 className="w-3 h-3 text-green-500" />
                               Verified & Processed
                            </p>
                          </div>
                       </div>
                       <div className="flex items-center gap-2">
                          <Button variant="secondary" size="sm" onClick={() => handleExportPdf(selectedTranscript)}>
                             <Download className="w-4 h-4 mr-2" /> Export PDF
                          </Button>
                       </div>
                    </header>

                    <div className="flex-1 grid grid-cols-1 md:grid-cols-2">
                       {/* Left Transcript Content */}
                       <div className="p-8 border-r border-slate-800 flex flex-col overflow-hidden max-h-[85vh]">
                          <div className="flex justify-between items-center mb-6">
                             <h4 className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold">
                                {viewLanguage === 'original' ? 'Smart Multi-Language Transcription (Verbatim)' : `Translated to ${viewLanguage}`}
                             </h4>
                             <div className="flex gap-2">
                                {viewLanguage !== 'original' && (
                                  <button 
                                    onClick={() => setViewLanguage('original')}
                                    className="text-[9px] bg-slate-950 px-2 py-0.5 rounded text-indigo-400 border border-indigo-500/20 font-bold hover:bg-slate-800 transition-colors"
                                  >
                                    Show Verbatim
                                  </button>
                                )}
                                {viewLanguage !== 'original' && (
                                  <button
                                    disabled={translating}
                                    onClick={() => handleTranslate(selectedTranscript, viewLanguage, true)}
                                    className="text-[9px] bg-slate-950 px-2 py-0.5 rounded text-indigo-400 border border-indigo-500/20 font-bold hover:bg-slate-800 transition-colors disabled:opacity-50"
                                  >
                                    Retranslate
                                  </button>
                                )}
                                <span className="text-[9px] bg-slate-950 px-2 py-0.5 rounded text-indigo-400 border border-indigo-500/20 font-bold">
                                  {viewLanguage === 'original' ? 'Verbatim Output' : 'Translated AI'}
                                </span>
                             </div>
                          </div>
                          
                          <div className="flex-1 overflow-y-auto pr-4 scrollbar-thin scrollbar-thumb-slate-800/50">
                             <div className="transcript-text text-[15px] leading-[1.8] text-slate-300 space-y-6">
                                <Markdown>
                                  {viewLanguage === 'original' 
                                    ? selectedTranscript.text 
                                    : translations.find(t => t.targetLanguage === viewLanguage)?.translatedText || "Translating... Please wait."}
                                </Markdown>
                             </div>
                          </div>

                          {/* Quick Translation Bar at the bottom of transcript */}
                          <div className="mt-6 pt-6 border-t border-slate-800">
                             <div className="flex items-center justify-between mb-4">
                                <h5 className="text-[9px] uppercase tracking-widest text-slate-500 font-bold flex items-center gap-2">
                                   <Languages className="w-3 h-3 text-indigo-400" />
                                   បកប្រែអត្ថបទបន្ត (Quick Translate)
                                </h5>
                             </div>
                             <div className="flex flex-wrap gap-2">
                                {[
                                  { label: 'អង់គ្លេស (English)', code: 'English' },
                                  { label: 'ខ្មែរ (Khmer)', code: 'Khmer' },
                                  { label: 'ចិន (Chinese)', code: 'Chinese' },
                                  { label: 'ថៃ (Thai)', code: 'Thai' }
                                ].map(lang => (
                                  <button 
                                    key={lang.code}
                                    disabled={translating}
                                    onClick={() => handleTranslate(selectedTranscript, lang.code)}
                                    className={cn(
                                      "px-3 py-1.5 border rounded-lg text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50",
                                      viewLanguage === lang.code 
                                        ? "bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-500/20" 
                                        : "bg-indigo-500/10 border-indigo-500/20 text-indigo-300 hover:bg-indigo-600 hover:text-white"
                                    )}
                                  >
                                    {translating && viewLanguage === lang.code ? '...' : lang.label}
                                  </button>
                                ))}
                             </div>
                          </div>
                       </div>

                       {/* Right Insight Panels */}
                       <div className="bg-slate-950/20 p-8 space-y-8 overflow-y-auto max-h-[85vh] scrollbar-thin scrollbar-thumb-slate-800/50">
                          <div className="space-y-4">
                             <div className="flex justify-between items-center">
                                <h4 className="text-[10px] uppercase tracking-widest text-purple-400 font-bold">សេចក្តីសង្ខេប (Executive Summary)</h4>
                                <div className="flex items-center gap-2">
                                   <Sparkles className="w-3 h-3 text-purple-500 animate-pulse" />
                                   <span className="text-[9px] font-bold uppercase tracking-widest text-purple-500/80">Smart Agent Active</span>
                                </div>
                             </div>
                             <div className="bg-slate-900/40 p-5 rounded-2xl border border-slate-800/50 shadow-inner">
                                <p className="text-xs text-slate-200 leading-[1.6] font-medium mb-4">{selectedTranscript.summary}</p>
                                
                                <div className="mt-4 pt-4 border-t border-slate-800/40">
                                   <div className="flex items-center gap-2 mb-3">
                                      <Zap className="w-3 h-3 text-slate-500" />
                                      <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">បញ្ជាភ្នាក់ងារ AI (Ask AI Agent)</span>
                                   </div>
                                   <div className="flex gap-2">
                                      <input 
                                         type="text" 
                                         value={agentInstruction}
                                         onChange={(e) => setAgentInstruction(e.target.value)}
                                         onKeyDown={(e) => {
                                            if (e.key === 'Enter' && agentInstruction.trim()) {
                                               handleResummarize(selectedTranscript, agentInstruction);
                                            }
                                         }}
                                         placeholder="ឧទាហរណ៍៖ សង្ខេបជាចំណុចៗ..."
                                         className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-700 focus:border-purple-500/50 outline-none transition-all"
                                      />
                                      <button 
                                         onClick={() => handleResummarize(selectedTranscript, agentInstruction)}
                                         disabled={summarizing || !agentInstruction.trim()}
                                         className="bg-purple-600 hover:bg-purple-500 disabled:opacity-30 text-white p-2 rounded-lg transition-all active:scale-90"
                                      >
                                         {summarizing ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                      </button>
                                   </div>
                                </div>
                             </div>
                          </div>

                          <div className="space-y-4">
                             <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">ចំណុចសំខាន់ៗ (Core Takeaways)</h4>
                             <ul className="grid gap-3">
                                {selectedTranscript.keyTakeaways?.map((item, i) => (
                                  <li key={i} className="flex gap-4 p-3 bg-slate-900/20 rounded-xl border border-slate-800/30 text-xs">
                                     <div className="w-5 h-5 flex-shrink-0 bg-indigo-500/10 text-indigo-400 flex items-center justify-center rounded-lg border border-indigo-500/20">
                                        <CheckCircle2 className="w-3 h-3" />
                                     </div>
                                     <span className="text-slate-400">{item}</span>
                                  </li>
                                ))}
                             </ul>
                          </div>

                          <div className="space-y-4">
                             <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">បកប្រែសង្ខេប (Translate Insights)</h4>
                             <div className="flex flex-wrap gap-2">
                                {[
                                  { label: 'ខ្មែរ', code: 'Khmer' },
                                  { label: 'ไทย', code: 'Thai' },
                                  { label: 'Tiếng Việt', code: 'Vietnamese' },
                                  { label: 'Bahasa ID', code: 'Indonesian' },
                                  { label: 'Malay', code: 'Malay' },
                                  { label: 'ဗមាစာ', code: 'Burmese' },
                                  { label: 'ພາສາລາវ', code: 'Lao' },
                                  { label: 'Tagalog', code: 'Tagalog' }
                                ].map(lang => (
                                  <button 
                                    key={lang.code}
                                    disabled={translating}
                                    onClick={() => handleTranslate(selectedTranscript, lang.code)}
                                    className={cn(
                                      "px-3 py-2 bg-slate-900 border rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all active:scale-95 flex items-center gap-2 disabled:opacity-50",
                                      viewLanguage === lang.code 
                                        ? "border-indigo-500 text-white bg-indigo-600/20" 
                                        : "border-slate-800 text-slate-400 hover:text-white hover:bg-indigo-600/20 hover:border-indigo-500/50"
                                    )}
                                  >
                                    <Languages className="w-3 h-3" />
                                    {translating && viewLanguage === lang.code ? '...' : lang.label}
                                  </button>
                                ))}
                             </div>
                          </div>

                          {/* Translations Display Area */}
                          {translations.length > 0 && (
                            <div className="space-y-6 pt-4 border-t border-slate-800/50">
                               <h4 className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold flex items-center gap-2">
                                  <Languages className="w-3 h-3" />
                                  លទ្ធផលបកប្រែ (Translation Library)
                               </h4>
                               <div className="space-y-4">
                                  {translations.map((t) => (
                                     <div key={t.id} className="bg-indigo-600/5 border border-indigo-500/10 rounded-2xl p-5 space-y-3">
                                        <div className="flex justify-between items-center mb-2">
                                           <span className="text-[10px] font-bold bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20">
                                              {t.targetLanguage}
                                           </span>
                                           {t.createdAt && <span className="text-[9px] text-slate-600">{formatDate(t.createdAt?.toDate())}</span>}
                                        </div>
                                        <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap transcript-text">
                                           <Markdown>{t.translatedText}</Markdown>
                                        </div>
                                     </div>
                                  ))}
                               </div>
                            </div>
                          )}
                       </div>
                    </div>
                 </GlassCard>
               ) : (
                 <div className="flex flex-col items-center justify-center h-[500px] text-center p-12 bg-slate-900/20 border-2 border-dashed border-slate-800 rounded-3xl group transition-colors hover:border-slate-700/50">
                    <div className="w-20 h-20 bg-slate-900 rounded-2xl flex items-center justify-center mb-8 border border-slate-800 shadow-xl group-hover:scale-110 transition-transform">
                       <FileText className="w-10 h-10 text-slate-600" />
                    </div>
                    <h3 className="text-lg font-bold text-slate-200 mb-2 uppercase tracking-wide">សួស្ដី</h3>
                    <p className="text-sm text-slate-500 max-w-xs leading-relaxed">
                       សូមជ្រើសរើសឯកសារពីបណ្ណាល័យ ឬបញ្ចូលឯកសារថ្មីដើម្បីចាប់ផ្ដើម។ (តើយើងគួរចាប់ផ្ដើមពីណា?)
                    </p>
                    <label htmlFor="file-upload" className="mt-8 cursor-pointer px-6 py-3 bg-indigo-600 rounded-xl text-xs font-bold uppercase tracking-widest text-white hover:bg-indigo-700 transition-colors shadow-xl shadow-indigo-500/20">
                       Start Upload
                    </label>
                 </div>
               )}
            </div>
          </div>
        </div>

        {/* Bottom Activity Bar */}
        <div className="h-10 shrink-0 bg-[#0C0C0E] border-t border-slate-800 px-8 flex items-center justify-between text-[9px] text-slate-600 uppercase tracking-widest font-black">
          <div className="flex gap-6">
            <span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> Gemini 1.5 Active</span>
            <span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]"></span> Service Status Online</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-indigo-400/50">v2.5.0-Deployment</span>
            <span className="text-white/40">Production Node</span>
          </div>
        </div>
      </main>
    </div>
  );
}
