
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlob, decode, decodeAudioData, encode } from './utils/audioUtils';
import { MicIcon, StopIcon, SparklesIcon, XIcon, UploadIcon, ClipboardIcon, MessageSquareIcon, FileTextIcon } from './components/IconComponents';
import { Spinner } from './components/Spinner';

type AppMode = 'conversation' | 'transcription';
type Status = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error' | 'processing';
type TranscriptEntry = {
  speaker: 'user' | 'ai';
  text: string;
};

const TranscriptDisplay: React.FC<{ text: string, speaker: 'user' | 'ai' }> = ({ text, speaker }) => (
    <div className={`p-4 rounded-2xl max-w-[85%] animate-fade-in ${speaker === 'user' ? 'bg-blue-600/30 self-end border border-blue-500/30' : 'bg-gray-700/50 self-start border border-gray-600/30'}`}>
        <p className={`text-[10px] uppercase tracking-wider font-bold mb-1 ${speaker === 'user' ? 'text-blue-300 text-right' : 'text-green-300'}`}>
            {speaker === 'user' ? 'You' : 'Kashmiri AI'}
        </p>
        <p className="text-white text-lg leading-relaxed">{text}</p>
    </div>
);

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('conversation');
  const [status, setStatus] = useState<Status>('idle');
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptEntry[]>([]);
  const [currentUserTranscript, setCurrentUserTranscript] = useState<string>('');
  const [currentAiTranscript, setCurrentAiTranscript] = useState<string>('');
  
  // Transcription Mode Specific States
  const [fileTranscription, setFileTranscription] = useState<string | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState<boolean>(false);

  // Summary states
  const [summary, setSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);

  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  const currentInputTranscriptionRef = useRef<string>('');
  const currentOutputTranscriptionRef = useRef<string>('');
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopSession = useCallback(async () => {
    setIsRecording(false);
    setStatus('idle');

    if (sessionPromiseRef.current) {
      try {
        const session = await sessionPromiseRef.current;
        session.close();
      } catch (e) {
        console.error('Error closing session:', e);
      }
      sessionPromiseRef.current = null;
    }
    
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
    }

    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }

    if (mediaStreamSourceRef.current) {
        mediaStreamSourceRef.current.disconnect();
        mediaStreamSourceRef.current = null;
    }

    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
        await inputAudioContextRef.current.close();
        inputAudioContextRef.current = null;
    }

    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
        audioSourcesRef.current.forEach(source => source.stop());
        audioSourcesRef.current.clear();
        await outputAudioContextRef.current.close();
        outputAudioContextRef.current = null;
    }
    
    setCurrentUserTranscript('');
    setCurrentAiTranscript('');
    currentInputTranscriptionRef.current = '';
    currentOutputTranscriptionRef.current = '';

  }, []);
  
  const startSession = useCallback(async () => {
    if (!process.env.API_KEY) {
      console.error("API_KEY environment variable not set.");
      setStatus('error');
      return;
    }

    setIsRecording(true);
    setStatus('connecting');
    setSummary(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      nextStartTimeRef.current = 0;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus('listening');
            mediaStreamSourceRef.current = inputAudioContextRef.current!.createMediaStreamSource(mediaStreamRef.current!);
            scriptProcessorRef.current = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);

            scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              if (sessionPromiseRef.current) {
                sessionPromiseRef.current.then((session) => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              }
            };

            mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
             if (message.serverContent?.inputTranscription) {
                const text = message.serverContent.inputTranscription.text;
                currentInputTranscriptionRef.current += text;
                setCurrentUserTranscript(currentInputTranscriptionRef.current);
             }
             if (message.serverContent?.outputTranscription) {
                if (mode === 'conversation') {
                  setStatus('speaking');
                }
                const text = message.serverContent.outputTranscription.text;
                currentOutputTranscriptionRef.current += text;
                setCurrentAiTranscript(currentOutputTranscriptionRef.current);
             }

             // Only play audio if in conversation mode
             const base64EncodedAudioString = message.serverContent?.modelTurn?.parts[0]?.inlineData.data;
             if (base64EncodedAudioString && outputAudioContextRef.current && mode === 'conversation') {
                 const audioContext = outputAudioContextRef.current;
                 nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContext.currentTime);
                 const audioBuffer = await decodeAudioData(decode(base64EncodedAudioString), audioContext, 24000, 1);
                 const source = audioContext.createBufferSource();
                 source.buffer = audioBuffer;
                 source.connect(audioContext.destination);

                 source.addEventListener('ended', () => {
                     audioSourcesRef.current.delete(source);
                     if (audioSourcesRef.current.size === 0) {
                         setStatus('listening');
                     }
                 });
                 
                 source.start(nextStartTimeRef.current);
                 nextStartTimeRef.current += audioBuffer.duration;
                 audioSourcesRef.current.add(source);
             }

             if (message.serverContent?.turnComplete) {
                if (currentInputTranscriptionRef.current.trim()) {
                    setTranscriptHistory(prev => [...prev, { speaker: 'user', text: currentInputTranscriptionRef.current.trim() }]);
                }
                if (currentOutputTranscriptionRef.current.trim() && mode === 'conversation') {
                    setTranscriptHistory(prev => [...prev, { speaker: 'ai', text: currentOutputTranscriptionRef.current.trim() }]);
                }
                currentInputTranscriptionRef.current = '';
                currentOutputTranscriptionRef.current = '';
                setCurrentUserTranscript('');
                setCurrentAiTranscript('');
             }
          },
          onerror: (e: ErrorEvent) => {
            console.error('Session error:', e);
            setStatus('error');
            stopSession();
          },
          onclose: (e: CloseEvent) => {
            stopSession();
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          systemInstruction: mode === 'conversation' 
            ? "You are an expert in the Kashmiri language (also known as Koshur). Your sole purpose is to have a friendly, natural, and helpful conversation with the user entirely in Kashmiri. Do not switch to English or any other language. Maintain a warm and encouraging tone."
            : "You are an expert Kashmiri transcriber. Your task is to accurately transcribe the user's spoken Kashmiri into text using Kashmiri script (Perso-Arabic). Do not respond to the content of the message, simply transcribe it as accurately as possible.",
        },
      });

    } catch (error) {
      console.error('Failed to start session:', error);
      setStatus('error');
      setIsRecording(false);
    }
  }, [stopSession, mode]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessingFile(true);
    setFileTranscription(null);
    setStatus('processing');

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: file.type,
                  data: base64Data,
                },
              },
              {
                text: "Please transcribe this audio file into Kashmiri text (Koshur). Use Kashmiri script (Perso-Arabic) for the final output. If the speech is clear, provide a verbatim transcription.",
              },
            ],
          },
        });

        setFileTranscription(response.text || "No transcription available.");
        setStatus('idle');
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error("Transcription error:", error);
      setStatus('error');
    } finally {
      setIsProcessingFile(false);
    }
  };

  const generateSummary = async () => {
    if (transcriptHistory.length === 0) return;
    
    setIsSummarizing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const fullTranscript = transcriptHistory.map(t => `${t.speaker === 'user' ? 'User' : 'AI'}: ${t.text}`).join('\n');
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Please provide a concise summary of the following conversation in the Kashmiri language (Koshur). Focus on the main topics discussed. Use Kashmiri script (Perso-Arabic) if possible, or clear Roman Kashmiri if not. 
        
        Conversation:
        ${fullTranscript}`,
      });
      
      setSummary(response.text || "Summary unavailable.");
    } catch (error) {
      console.error("Failed to generate summary:", error);
      setSummary("Error generating summary.");
    } finally {
      setIsSummarizing(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Could add a toast here
  };

  const handleToggleConversation = () => {
    if (isRecording) {
      stopSession();
    } else {
      startSession();
    }
  };
  
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, [stopSession]);

  const getStatusText = () => {
    switch (status) {
      case 'idle': return mode === 'conversation' ? 'Press start to begin conversation' : 'Record or upload to transcribe';
      case 'connecting': return 'Connecting to Kashmiri AI...';
      case 'listening': return mode === 'conversation' ? 'Listening... (Speak now)' : 'Recording for transcription...';
      case 'speaking': return 'AI is responding in Kashmiri...';
      case 'processing': return 'Transcribing audio file...';
      case 'error': return 'Connection error. Please restart.';
      default: return '';
    }
  };

  return (
    <div className="min-h-screen bg-[#0b0f1a] flex flex-col items-center justify-center p-4 font-sans selection:bg-green-500/30">
      <div className="w-full max-w-2xl h-[90vh] flex flex-col bg-[#161b2a] rounded-3xl shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-white/5 overflow-hidden relative">
        
        <header className="px-6 py-4 border-b border-white/5 bg-white/2 backdrop-blur-md sticky top-0 z-10">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                    Kashmiri AI
                </h1>
                <p className="text-[10px] text-gray-400 font-medium uppercase tracking-[0.2em] mt-0.5">Real-time Koshur Transcription</p>
              </div>
              <div className="flex items-center gap-2">
                {transcriptHistory.length > 0 && !isRecording && mode === 'conversation' && (
                  <button 
                    onClick={generateSummary}
                    disabled={isSummarizing}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-xs font-semibold text-white transition-colors disabled:opacity-50"
                  >
                    {isSummarizing ? <Spinner className="w-3 h-3" /> : <SparklesIcon className="w-3 h-3 text-yellow-400" />}
                    Summarize
                  </button>
                )}
              </div>
            </div>

            <div className="flex p-1 bg-black/30 rounded-xl w-full">
              <button 
                onClick={() => { if(!isRecording) setMode('conversation'); }}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${mode === 'conversation' ? 'bg-white/10 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
              >
                <MessageSquareIcon className="w-4 h-4" />
                Conversation
              </button>
              <button 
                onClick={() => { if(!isRecording) setMode('transcription'); }}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${mode === 'transcription' ? 'bg-white/10 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
              >
                <FileTextIcon className="w-4 h-4" />
                Audio to Text
              </button>
            </div>
        </header>

        <main className="flex-1 p-6 overflow-y-auto space-y-6 flex flex-col scroll-smooth custom-scrollbar">
            {summary && (
              <div className="bg-emerald-500/10 border border-emerald-500/20 p-5 rounded-2xl relative animate-in fade-in slide-in-from-top-4 duration-500">
                <button onClick={() => setSummary(null)} className="absolute top-3 right-3 text-emerald-300/50 hover:text-emerald-300">
                  <XIcon className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-2 mb-2">
                  <SparklesIcon className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-emerald-400">Summary (مختصر)</h3>
                </div>
                <p className="text-emerald-50 text-base leading-relaxed">{summary}</p>
              </div>
            )}

            {mode === 'transcription' && fileTranscription && (
              <div className="bg-blue-500/10 border border-blue-500/20 p-5 rounded-2xl relative animate-in zoom-in-95 duration-300">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileTextIcon className="w-4 h-4 text-blue-400" />
                    <h3 className="text-xs font-bold uppercase tracking-widest text-blue-400">File Transcription</h3>
                  </div>
                  <button onClick={() => copyToClipboard(fileTranscription)} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-blue-300 transition-colors">
                    <ClipboardIcon className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-white text-lg leading-relaxed text-right dir-rtl font-arabic">{fileTranscription}</p>
              </div>
            )}

            {transcriptHistory.length === 0 && !isRecording && !summary && !fileTranscription && (
              <div className="flex-1 flex flex-col items-center justify-center text-center opacity-40 px-10">
                <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6">
                  {mode === 'conversation' ? <MicIcon className="w-10 h-10" /> : <FileTextIcon className="w-10 h-10" />}
                </div>
                <h2 className="text-xl font-semibold mb-2">
                  {mode === 'conversation' ? 'Ready to talk?' : 'Ready to transcribe?'}
                </h2>
                <p className="text-sm">
                  {mode === 'conversation' 
                    ? 'Start a real-time voice conversation in Kashmiri.' 
                    : 'Record your voice or upload an audio file to get high-accuracy Kashmiri text.'}
                </p>
              </div>
            )}

            <div className="space-y-4 flex flex-col">
              {transcriptHistory.map((entry, index) => (
                  <TranscriptDisplay key={index} text={entry.text} speaker={entry.speaker} />
              ))}
              {currentUserTranscript && <TranscriptDisplay text={currentUserTranscript} speaker='user' />}
              {currentAiTranscript && mode === 'conversation' && <TranscriptDisplay text={currentAiTranscript} speaker='ai'/>}
            </div>
        </main>

        <footer className="p-8 border-t border-white/5 bg-black/20 flex flex-col items-center justify-center">
            <div className="mb-6 h-4 text-center">
                <p className="text-xs font-medium uppercase tracking-[0.1em] text-gray-400 animate-pulse">{getStatusText()}</p>
            </div>
            
            <div className="flex items-center gap-8">
              {mode === 'transcription' && !isRecording && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessingFile}
                  className="w-16 h-16 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-gray-300 transition-all active:scale-95 disabled:opacity-50"
                  title="Upload audio file"
                >
                  {isProcessingFile ? <Spinner className="w-6 h-6" /> : <UploadIcon className="w-8 h-8" />}
                </button>
              )}

              <div className="relative group">
                {isRecording && (
                  <div className="absolute inset-0 bg-red-500/20 rounded-full blur-2xl animate-pulse"></div>
                )}
                <button
                    onClick={handleToggleConversation}
                    disabled={status === 'connecting' || isProcessingFile}
                    className={`relative w-24 h-24 rounded-full flex items-center justify-center text-white transition-all duration-500 ease-out shadow-2xl focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50 disabled:scale-95 ${isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'} ${isRecording ? 'scale-110' : 'hover:scale-105 active:scale-95'}`}
                >
                    {status === 'connecting' && <Spinner className="w-10 h-10" />}
                    {status !== 'connecting' && (isRecording ? <StopIcon className="w-10 h-10" /> : <MicIcon className="w-10 h-10" />)}
                </button>
              </div>

              {mode === 'transcription' && !isRecording && (
                <div className="w-16 h-16 opacity-0 pointer-events-none"></div> // Spacer to keep mic centered
              )}
            </div>
            
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              className="hidden" 
              accept="audio/*"
            />
            
            <p className="mt-8 text-[10px] text-gray-500 font-bold uppercase tracking-widest">Created by Tasneem Mustafa</p>
        </footer>
      </div>
    </div>
  );
};

export default App;
