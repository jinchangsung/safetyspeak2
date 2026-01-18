import React, { useState, useRef, useEffect, useCallback } from 'react';
import { AppState, TargetLanguage, LANGUAGE_LABELS, QueueItem } from './types';
import { translateSafetyText, generateSpeech, extractTextFromFile } from './services/geminiService';
import { isValidFileType, isValidFileSize, MAX_FILE_SIZE_MB } from './services/fileUtils';
import { 
  Megaphone, 
  Play, 
  Pause,
  Square, 
  AlertTriangle, 
  Loader2, 
  Volume2,
  HardHat,
  Upload,
  FileText,
  X,
  VolumeX,
  Plus,
  Trash2,
  CheckCircle2,
  ListOrdered,
  Globe
} from 'lucide-react';

const MAX_INPUT_LENGTH = 10000; 

// Karaoke Text Component
const HighlightedText = ({ text, progress, isPlaying, isPaused }: { text: string, progress: number, isPlaying: boolean, isPaused: boolean }) => {
  // If not playing and not paused (completely stopped), show plain text
  if (!isPlaying && !isPaused) {
    return <div className="text-slate-600 text-sm whitespace-pre-wrap leading-relaxed">{text}</div>;
  }

  // If playing or paused, show gradient text based on progress
  return (
    <div 
      className="text-sm font-medium whitespace-pre-wrap transition-all duration-75 leading-relaxed"
      style={{
        backgroundImage: `linear-gradient(to bottom, #2563eb ${progress}%, #cbd5e1 ${progress}%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        color: 'transparent'
      }}
    >
      {text}
    </div>
  );
};

const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    queue: [],
    selectedLanguage: TargetLanguage.CHINESE,
    isProcessingQueue: false,
    currentItemId: null,
    globalError: null,
    autoPlay: true, // Automatically play items as they finish or sequentially
  });

  const [manualInput, setManualInput] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Audio refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const offsetRef = useRef<number>(0); // Track where we paused
  
  const [playingItemId, setPlayingItemId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [playbackProgress, setPlaybackProgress] = useState<number>(0);

  // Initialize AudioContext
  const getAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000
      });
    }
    return audioContextRef.current;
  };

  // --- Queue Processing Logic ---

  // Generate a simple ID
  const generateId = () => Math.random().toString(36).substr(2, 9);

  const addToQueue = (items: QueueItem[]) => {
    setState(prev => ({
      ...prev,
      queue: [...prev.queue, ...items],
      globalError: null
    }));
  };

  const removeFromQueue = (id: string) => {
    setState(prev => ({
      ...prev,
      queue: prev.queue.filter(item => item.id !== id)
    }));
    if (playingItemId === id) stopAudio();
  };

  const clearQueue = () => {
    stopAudio();
    setState(prev => ({ ...prev, queue: [], isProcessingQueue: false, currentItemId: null }));
  };

  const updateItemStatus = (id: string, updates: Partial<QueueItem>) => {
    setState(prev => ({
      ...prev,
      queue: prev.queue.map(item => item.id === id ? { ...item, ...updates } : item)
    }));
  };

  const addTranslationJob = (sourceItem: QueueItem, lang: TargetLanguage) => {
    const newItem: QueueItem = {
        id: generateId(),
        file: sourceItem.file, // Keep file reference if it exists
        fileName: sourceItem.fileName,
        originalText: sourceItem.originalText, // Reuse extracted text
        targetLanguage: lang,
        status: 'idle' // Since originalText is present, it will skip extraction
    };
    addToQueue([newItem]);
  };

  // Main Processing Loop
  useEffect(() => {
    let isCancelled = false;

    const processNext = async () => {
      if (!state.isProcessingQueue || isCancelled) return;

      // Find the next 'idle' item
      const nextItem = state.queue.find(item => item.status === 'idle');

      if (!nextItem) {
        // No more items to process
        setState(prev => ({ ...prev, isProcessingQueue: false, currentItemId: null }));
        return;
      }

      setState(prev => ({ ...prev, currentItemId: nextItem.id }));

      try {
        // 1. Extraction (if needed)
        let textToTranslate = nextItem.originalText;
        
        // Only extract if we don't have text yet AND we have a file
        if (!textToTranslate && nextItem.file) {
          updateItemStatus(nextItem.id, { status: 'extracting' });
          try {
             textToTranslate = await extractTextFromFile(nextItem.file);
             if (textToTranslate.length > MAX_INPUT_LENGTH) {
                 textToTranslate = textToTranslate.slice(0, MAX_INPUT_LENGTH);
             }
             updateItemStatus(nextItem.id, { originalText: textToTranslate });
          } catch (e: any) {
             throw new Error(`파일 읽기 실패: ${e.message}`);
          }
        }

        if (!textToTranslate && !nextItem.file) {
             throw new Error("번역할 텍스트가 없습니다.");
        }
        
        // Safety check if extraction returned empty
        if (!textToTranslate.trim()) {
            throw new Error("텍스트를 추출할 수 없거나 내용이 비어있습니다.");
        }

        // 2. Translation (Skip if Korean)
        updateItemStatus(nextItem.id, { status: 'translating' });
        
        let translated: string;
        if (nextItem.targetLanguage === TargetLanguage.KOREAN) {
            translated = textToTranslate;
            await new Promise(resolve => setTimeout(resolve, 300));
        } else {
            translated = await translateSafetyText(textToTranslate, nextItem.targetLanguage);
        }
        
        updateItemStatus(nextItem.id, { translatedText: translated });

        // 3. TTS Generation
        updateItemStatus(nextItem.id, { status: 'speaking' });
        const audioCtx = getAudioContext();
        let audioBuffer: AudioBuffer | null = null;
        
        try {
            audioBuffer = await generateSpeech(translated, audioCtx);
        } catch (ttsError: any) {
            console.error("TTS generation failed, proceeding without audio", ttsError);
        }

        updateItemStatus(nextItem.id, { 
            status: 'completed', 
            audioBuffer: audioBuffer,
            error: audioBuffer ? undefined : '음성 생성 실패'
        });

      } catch (error: any) {
        updateItemStatus(nextItem.id, { 
            status: 'error', 
            error: error.message || '처리 중 오류 발생' 
        });
      }

      setTimeout(() => {
         if(!isCancelled) processNext(); 
      }, 100);
    };

    if (state.isProcessingQueue && !state.currentItemId) {
        processNext();
    } else if (state.isProcessingQueue && state.currentItemId) {
        // Allow the current item to finish
    }

    return () => { isCancelled = true; };
  }, [state.isProcessingQueue, state.queue, state.currentItemId]);


  // --- Audio Handlers ---

  const playAudio = async (buffer: AudioBuffer, id: string, resume: boolean = false) => {
    const ctx = getAudioContext();
    
    // If playing a new item (not resuming), stop previous one completely
    if (!resume && playingItemId && playingItemId !== id) {
      stopAudio();
    }
    
    // If we are currently playing and user clicked play again (restart), stop first
    if (audioSourceRef.current && !resume) {
        stopAudio();
    }

    if (ctx.state === 'suspended') await ctx.resume();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    
    source.onended = () => {
      // Only reset if we reached the end naturally, not if we paused manually
      if (!isPaused) {
        stopAudio();
      }
    };

    // Determine start time (offset)
    // If resuming, use stored offset. If new play, start from 0.
    const startOffset = resume ? offsetRef.current : 0;
    
    // IMPORTANT: start(when, offset)
    source.start(0, startOffset);
    
    audioSourceRef.current = source;
    startTimeRef.current = ctx.currentTime;
    
    // If it's a new play, reset offsetRef for tracking
    if (!resume) {
        offsetRef.current = 0;
    }

    setPlayingItemId(id);
    setIsPaused(false);

    // Animation loop for progress
    const updateProgress = () => {
      if (!audioSourceRef.current) return;
      
      const elapsedSinceStart = ctx.currentTime - startTimeRef.current;
      const totalElapsed = offsetRef.current + elapsedSinceStart;
      const duration = buffer.duration;
      const progress = Math.min((totalElapsed / duration) * 100, 100);
      
      setPlaybackProgress(progress);
      
      if (progress < 100) {
        animationFrameRef.current = requestAnimationFrame(updateProgress);
      }
    };
    
    // Cancel any existing loop
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = requestAnimationFrame(updateProgress);
  };

  const pauseAudio = () => {
      if (!audioSourceRef.current) return;
      
      const ctx = getAudioContext();
      // Calculate how much played in this session
      const elapsed = ctx.currentTime - startTimeRef.current;
      // Add to accumulated offset
      offsetRef.current += elapsed;

      // Stop source
      // Remove onended to prevent it from triggering "finished" logic
      audioSourceRef.current.onended = null;
      audioSourceRef.current.stop();
      audioSourceRef.current = null;
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      
      setIsPaused(true);
  };

  const stopAudio = () => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.onended = null;
        audioSourceRef.current.stop();
      } catch(e) {}
      audioSourceRef.current = null;
    }
    
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    setPlayingItemId(null);
    setIsPaused(false);
    offsetRef.current = 0;
    setPlaybackProgress(0);
  };

  // --- File Handlers ---

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    
    const newItems: QueueItem[] = [];
    const files = Array.from(fileList);

    files.forEach(file => {
        if (!isValidFileType(file)) return;
        
        newItems.push({
            id: generateId(),
            file: file,
            fileName: file.name,
            originalText: '',
            targetLanguage: state.selectedLanguage,
            status: 'idle'
        });
    });

    if (newItems.length === 0 && files.length > 0) {
        setState(prev => ({...prev, globalError: '지원되지 않는 파일 형식이 포함되어 있습니다.'}));
    } else {
        addToQueue(newItems);
    }
  };

  const addManualInput = () => {
    if (!manualInput.trim()) return;
    
    addToQueue([{
        id: generateId(),
        fileName: '직접 입력한 텍스트',
        originalText: manualInput,
        targetLanguage: state.selectedLanguage,
        status: 'idle'
    }]);
    setManualInput('');
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  const toggleProcessing = () => {
    if (state.isProcessingQueue) {
        setState(prev => ({ ...prev, isProcessingQueue: false }));
    } else {
        setState(prev => ({ ...prev, isProcessingQueue: true, currentItemId: null }));
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 font-sans">
      {/* Header */}
      <header className="bg-slate-900 text-white shadow-lg relative overflow-hidden flex-shrink-0">
        <div className="absolute top-0 left-0 w-full h-2 caution-stripe"></div>
        <div className="container mx-auto px-4 py-6 flex items-center justify-between z-10 relative">
          <div className="flex items-center space-x-3">
            <div className="bg-yellow-500 p-2 rounded-lg text-slate-900">
              <HardHat size={32} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">
                Safety<span className="text-yellow-500">Speak</span>
              </h1>
              <p className="text-slate-400 text-sm">건설현장 다국어 안전교육 통역기 (Batch) v1.1</p>
            </div>
          </div>
          <div className="hidden md:flex items-center space-x-2 text-yellow-500 text-sm font-semibold uppercase tracking-wider border border-yellow-500/30 px-3 py-1 rounded bg-yellow-500/10">
            <ListOrdered size={16} />
            <span>Multi-File Support</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow container mx-auto px-4 py-6 max-w-6xl flex flex-col md:flex-row gap-6 h-[calc(100vh-140px)]">
        
        {/* Left Panel */}
        <section className="md:w-1/3 flex flex-col gap-4 overflow-y-auto">
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                <label className="block text-sm font-bold text-slate-700 mb-2">통역 언어 선택</label>
                <div className="grid grid-cols-2 gap-2">
                    {Object.values(TargetLanguage).map((lang) => {
                        const info = LANGUAGE_LABELS[lang];
                        const isSelected = state.selectedLanguage === lang;
                        return (
                        <button
                            key={lang}
                            onClick={() => setState(prev => ({ ...prev, selectedLanguage: lang }))}
                            className={`flex items-center p-2 rounded-lg border transition-all text-sm ${
                            isSelected 
                                ? 'border-blue-600 bg-blue-50 text-blue-700 font-bold' 
                                : 'border-slate-200 hover:bg-slate-50'
                            }`}
                        >
                            <span className="mr-2 text-lg">{info.flag}</span>
                            <span>{info.label}</span>
                        </button>
                        );
                    })}
                </div>
            </div>

            <div 
                className={`flex-shrink-0 border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center transition-all cursor-pointer bg-white ${
                    dragActive ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-blue-400'
                }`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
            >
                <input 
                    ref={fileInputRef}
                    type="file" 
                    className="hidden" 
                    multiple
                    accept=".docx,.xlsx,.pptx,.hwp,.txt,.pdf"
                    onChange={(e) => handleFiles(e.target.files)}
                />
                <div className="bg-slate-100 p-3 rounded-full mb-3">
                    <Upload className="text-slate-500" size={24} />
                </div>
                <p className="text-slate-700 font-bold mb-1">파일 업로드 (최대 300개)</p>
                <p className="text-xs text-slate-500">
                    PDF, DOCX, XLSX, TXT 지원<br/>
                    드래그 앤 드롭 또는 클릭
                </p>
            </div>

            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col flex-grow">
                <label className="block text-sm font-bold text-slate-700 mb-2">직접 입력</label>
                <textarea 
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    placeholder="내용을 입력하세요..."
                    className="w-full flex-grow p-3 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none mb-2 min-h-[100px]"
                />
                <button 
                    onClick={addManualInput}
                    disabled={!manualInput.trim()}
                    className="w-full py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-700 disabled:bg-slate-300 flex items-center justify-center"
                >
                    <Plus size={16} className="mr-1" /> 목록에 추가
                </button>
            </div>
        </section>

        {/* Right Panel */}
        <section className="md:w-2/3 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-slate-100 px-4 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center">
                    <ListOrdered className="mr-2 text-slate-600" size={20} />
                    <h2 className="font-bold text-slate-700">재생 목록 ({state.queue.length})</h2>
                </div>
                
                <div className="flex items-center space-x-2">
                    {state.queue.length > 0 && (
                        <button 
                            onClick={clearQueue}
                            className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1"
                        >
                            전체 삭제
                        </button>
                    )}
                    <button
                        onClick={toggleProcessing}
                        disabled={state.queue.length === 0}
                        className={`flex items-center px-4 py-2 rounded-lg font-bold text-white shadow-sm transition-all ${
                            state.isProcessingQueue 
                                ? 'bg-red-500 hover:bg-red-600'
                                : state.queue.length === 0 
                                    ? 'bg-slate-300 cursor-not-allowed'
                                    : 'bg-blue-600 hover:bg-blue-700'
                        }`}
                    >
                        {state.isProcessingQueue ? (
                            <>
                                <Pause size={18} className="mr-2" /> 정지
                            </>
                        ) : (
                            <>
                                <Play size={18} className="mr-2" /> 
                                {state.queue.some(i => i.status === 'completed') ? '계속 진행' : '통역 시작'}
                            </>
                        )}
                    </button>
                </div>
            </div>

            <div className="flex-grow overflow-y-auto p-4 space-y-3 bg-slate-50">
                {state.queue.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 opacity-60">
                        <FileText size={48} className="mb-4" />
                        <p className="text-lg font-medium">재생 목록이 비어있습니다</p>
                        <p className="text-sm">왼쪽에서 파일을 추가하거나 텍스트를 입력하세요.</p>
                    </div>
                ) : (
                    state.queue.map((item, index) => (
                        <div 
                            key={item.id}
                            className={`relative bg-white rounded-lg border shadow-sm p-4 transition-all ${
                                item.status === 'error' ? 'border-red-300 bg-red-50' :
                                item.id === state.currentItemId ? 'border-blue-500 ring-1 ring-blue-500 shadow-md' :
                                item.status === 'completed' ? 'border-green-200 bg-green-50/30' :
                                'border-slate-200'
                            }`}
                        >
                            <div className="flex justify-between items-start mb-2">
                                <div className="flex items-center overflow-hidden">
                                    <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-0.5 rounded mr-2 flex-shrink-0">
                                        #{index + 1}
                                    </span>
                                    <h3 className="font-semibold text-slate-800 truncate" title={item.fileName}>
                                        {item.fileName}
                                    </h3>
                                </div>
                                <div className="flex items-center space-x-2 flex-shrink-0 ml-2">
                                    {item.status === 'idle' && <span className="text-xs text-slate-400 bg-slate-100 px-2 py-1 rounded">대기중</span>}
                                    {item.status === 'extracting' && <span className="text-xs text-blue-600 bg-blue-100 px-2 py-1 rounded flex items-center"><Loader2 size={12} className="animate-spin mr-1"/>내용 읽는 중</span>}
                                    {item.status === 'translating' && <span className="text-xs text-purple-600 bg-purple-100 px-2 py-1 rounded flex items-center"><Loader2 size={12} className="animate-spin mr-1"/>번역 중</span>}
                                    {item.status === 'speaking' && <span className="text-xs text-orange-600 bg-orange-100 px-2 py-1 rounded flex items-center"><Loader2 size={12} className="animate-spin mr-1"/>음성 생성 중</span>}
                                    {item.status === 'completed' && <span className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded flex items-center"><CheckCircle2 size={12} className="mr-1"/>완료</span>}
                                    {item.status === 'error' && <span className="text-xs text-red-600 bg-red-100 px-2 py-1 rounded flex items-center"><AlertTriangle size={12} className="mr-1"/>오류</span>}
                                    
                                    <button onClick={() => removeFromQueue(item.id)} className="text-slate-400 hover:text-red-500 p-1">
                                        <X size={16} />
                                    </button>
                                </div>
                            </div>

                            {(item.translatedText || item.originalText) && (
                                <div className="mb-3 bg-slate-50 p-3 rounded border border-slate-100">
                                    <div className="mb-2">
                                        <div className="text-xs font-bold text-slate-400 mb-1">원본 (한국어)</div>
                                        <HighlightedText 
                                            text={item.originalText} 
                                            progress={playbackProgress} 
                                            isPlaying={playingItemId === item.id}
                                            isPaused={playingItemId === item.id && isPaused}
                                        />
                                    </div>
                                    {item.translatedText && (
                                        <div className="pt-2 border-t border-slate-200 mt-2">
                                            <div className="text-xs font-bold text-slate-400 mb-1">{LANGUAGE_LABELS[item.targetLanguage].native}</div>
                                            <HighlightedText 
                                                text={item.translatedText} 
                                                progress={playbackProgress} 
                                                isPlaying={playingItemId === item.id}
                                                isPaused={playingItemId === item.id && isPaused}
                                            />
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Additional Translation Options (Only show if text is extracted/available) */}
                            {(item.originalText && item.status !== 'extracting' && item.status !== 'error') && (
                                <div className="mb-3 pt-2 border-t border-slate-100">
                                    <div className="text-[10px] uppercase text-slate-400 font-bold mb-1.5 flex items-center">
                                        <Globe size={10} className="mr-1" /> 다른 언어로 추가 번역
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {Object.values(TargetLanguage).map((lang) => {
                                            if (lang === item.targetLanguage) return null; // Skip current lang
                                            return (
                                                <button
                                                    key={lang}
                                                    onClick={() => addTranslationJob(item, lang)}
                                                    className="flex items-center space-x-1 px-2 py-1 bg-slate-50 border border-slate-200 rounded text-xs hover:bg-blue-50 hover:border-blue-200 hover:text-blue-700 transition-colors"
                                                    title={`${LANGUAGE_LABELS[lang].label}로 추가 번역`}
                                                >
                                                    <span>{LANGUAGE_LABELS[lang].flag}</span>
                                                    <span className="font-medium text-[10px]">{LANGUAGE_LABELS[lang].native}</span>
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                            )}

                            {item.error && (
                                <div className="text-xs text-red-600 mb-2">
                                    {item.error}
                                </div>
                            )}

                            {item.status === 'completed' && item.audioBuffer && (
                                <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                                    <div className="text-xs text-slate-500">
                                        {LANGUAGE_LABELS[item.targetLanguage].native} 번역됨
                                    </div>
                                    <div className="flex items-center space-x-2">
                                        {playingItemId === item.id && (
                                            <button
                                                onClick={stopAudio}
                                                className="flex items-center px-3 py-1.5 rounded-full text-xs font-bold transition-all bg-red-500 text-white hover:bg-red-600"
                                            >
                                                <Square size={12} fill="currentColor" className="mr-1"/> 정지
                                            </button>
                                        )}
                                        <button
                                            onClick={() => {
                                              if (playingItemId === item.id) {
                                                // If currently playing/paused this item
                                                if (isPaused) {
                                                  playAudio(item.audioBuffer!, item.id, true); // Resume
                                                } else {
                                                  pauseAudio(); // Pause
                                                }
                                              } else {
                                                // Playing a new item
                                                playAudio(item.audioBuffer!, item.id, false); 
                                              }
                                            }}
                                            className={`flex items-center px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                                                playingItemId === item.id 
                                                ? (isPaused ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-amber-500 text-white hover:bg-amber-600')
                                                : 'bg-green-500 text-white hover:bg-green-600'
                                            }`}
                                        >
                                            {playingItemId === item.id ? (
                                                isPaused ? (
                                                  <><Play size={12} fill="currentColor" className="mr-1"/> 이어듣기</>
                                                ) : (
                                                  <><Pause size={12} fill="currentColor" className="mr-1"/> 일시정지</>
                                                )
                                            ) : (
                                                <><Play size={12} fill="currentColor" className="mr-1"/> 다시 듣기</>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        </section>
      </main>
      
      {state.globalError && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-full shadow-xl flex items-center z-50 animate-bounce">
            <AlertTriangle className="mr-2" size={20} />
            {state.globalError}
            <button onClick={() => setState(prev => ({...prev, globalError: null}))} className="ml-4 hover:text-red-200">
                <X size={18} />
            </button>
        </div>
      )}
    </div>
  );
};

export default App;
