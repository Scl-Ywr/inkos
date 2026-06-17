import { useState, useCallback, useRef, useEffect } from "react";

export interface SpeechOptions {
  readonly rate?: number;    // 0.5 - 2.0, default 1.0
  readonly pitch?: number;   // 0 - 2, default 1.0
  readonly volume?: number;  // 0 - 1, default 1.0
  readonly voice?: SpeechSynthesisVoice | null;
}

export interface SpeechState {
  readonly isSpeaking: boolean;
  readonly isPaused: boolean;
  readonly currentSentence: number;
  readonly totalSentences: number;
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>({
    isSpeaking: false,
    isPaused: false,
    currentSentence: 0,
    totalSentences: 0,
  });

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const sentencesRef = useRef<string[]>([]);
  const currentIndexRef = useRef(0);

  // Check if speech synthesis is supported
  const isSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  // Get available voices
  const getVoices = useCallback((): SpeechSynthesisVoice[] => {
    if (!isSupported) return [];
    return window.speechSynthesis.getVoices();
  }, [isSupported]);

  // Get Chinese voices
  const getChineseVoices = useCallback((): SpeechSynthesisVoice[] => {
    return getVoices().filter((voice) =>
      voice.lang.startsWith("zh") || voice.lang.startsWith("cmn")
    );
  }, [getVoices]);

  // Split text into sentences
  const splitSentences = useCallback((text: string): string[] => {
    // Chinese sentence splitting: 。！？；
    const sentences = text
      .split(/(?<=[。！？；\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return sentences;
  }, []);

  // Speak text
  const speak = useCallback((text: string, options?: SpeechOptions) => {
    if (!isSupported) {
      console.warn("Speech synthesis not supported");
      return;
    }

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const sentences = splitSentences(text);
    sentencesRef.current = sentences;
    currentIndexRef.current = 0;

    setState({
      isSpeaking: true,
      isPaused: false,
      currentSentence: 0,
      totalSentences: sentences.length,
    });

    // Speak each sentence sequentially
    const speakNext = (index: number) => {
      if (index >= sentences.length) {
        setState((prev) => ({ ...prev, isSpeaking: false, isPaused: false }));
        return;
      }

      currentIndexRef.current = index;
      setState((prev) => ({ ...prev, currentSentence: index }));

      const utterance = new SpeechSynthesisUtterance(sentences[index]);
      utterance.rate = options?.rate ?? 1.0;
      utterance.pitch = options?.pitch ?? 1.0;
      utterance.volume = options?.volume ?? 1.0;

      // Use Chinese voice if available
      const chineseVoice = options?.voice ?? getChineseVoices()[0];
      if (chineseVoice) {
        utterance.voice = chineseVoice;
      }

      utterance.onend = () => {
        speakNext(index + 1);
      };

      utterance.onerror = (event) => {
        if (event.error !== "canceled") {
          console.error("Speech error:", event.error);
          setState((prev) => ({ ...prev, isSpeaking: false, isPaused: false }));
        }
      };

      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    };

    speakNext(0);
  }, [isSupported, splitSentences, getChineseVoices]);

  // Pause speech
  const pause = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.pause();
    setState((prev) => ({ ...prev, isPaused: true }));
  }, [isSupported]);

  // Resume speech
  const resume = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.resume();
    setState((prev) => ({ ...prev, isPaused: false }));
  }, [isSupported]);

  // Stop speech
  const stop = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.cancel();
    setState({
      isSpeaking: false,
      isPaused: false,
      currentSentence: 0,
      totalSentences: 0,
    });
  }, [isSupported]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isSupported) {
        window.speechSynthesis.cancel();
      }
    };
  }, [isSupported]);

  return {
    ...state,
    isSupported,
    speak,
    pause,
    resume,
    stop,
    getVoices,
    getChineseVoices,
  };
}
