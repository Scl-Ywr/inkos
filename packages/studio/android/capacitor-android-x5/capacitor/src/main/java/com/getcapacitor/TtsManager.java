package com.getcapacitor;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Manages Android TextToSpeech for GeckoView (where Web Speech API is unavailable).
 * Uses the system TTS engine — no network or API key needed.
 */
public class TtsManager implements TextToSpeech.OnInitListener {
    private final Context context;
    private TextToSpeech tts;
    private boolean ready = false;
    private final AtomicReference<TtsState> state = new AtomicReference<>(TtsState.IDLE);
    private int totalChars = 0;
    private int spokenChars = 0;

    enum TtsState { IDLE, SPEAKING, PAUSED }

    public TtsManager(Context context) {
        this.context = context;
        this.tts = new TextToSpeech(context, this);
    }

    @Override
    public void onInit(int status) {
        ready = (status == TextToSpeech.SUCCESS);
        if (ready) {
            tts.setLanguage(Locale.CHINESE);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {
                    state.set(TtsState.SPEAKING);
                }
                @Override public void onDone(String utteranceId) {
                    // Each utterance done — advance progress
                    String[] parts = utteranceId.split(":");
                    if (parts.length >= 2) {
                        try { spokenChars = Integer.parseInt(parts[1]); } catch (Exception ignored) {}
                    }
                    // If all text spoken, mark as idle
                    if (spokenChars >= totalChars) {
                        state.set(TtsState.IDLE);
                    }
                }
                @Override public void onError(String utteranceId) {
                    state.set(TtsState.IDLE);
                }
            });
        }
    }

    /** Speak the given text, splitting into chunks for progress tracking. */
    public void speak(String text, float rate) {
        if (!ready || tts == null) return;
        tts.stop();
        totalChars = text.length();
        spokenChars = 0;
        state.set(TtsState.SPEAKING);

        if (rate > 0) tts.setSpeechRate(rate);

        // Split into ~200 char chunks for progress tracking
        int chunkSize = 200;
        int chunks = (int) Math.ceil((double) text.length() / chunkSize);
        for (int i = 0; i < chunks; i++) {
            int start = i * chunkSize;
            int end = Math.min(start + chunkSize, text.length());
            String chunk = text.substring(start, end);
            int progress = end; // chars spoken so far
            tts.speak(chunk, TextToSpeech.QUEUE_ADD, null, "chunk:" + progress);
        }
    }

    public void pause() {
        if (tts != null && state.get() == TtsState.SPEAKING) {
            tts.stop(); // Android TTS doesn't have native pause; stop and remember position
            state.set(TtsState.PAUSED);
        }
    }

    public void resume() {
        // Android TTS has no native resume; we'd need to re-speak from last position
        // For simplicity, just set state back to idle (user needs to re-trigger)
        state.set(TtsState.IDLE);
    }

    public void stop() {
        if (tts != null) {
            tts.stop();
        }
        state.set(TtsState.IDLE);
        spokenChars = 0;
        totalChars = 0;
    }

    public boolean isSpeaking() {
        return state.get() == TtsState.SPEAKING;
    }

    public boolean isPaused() {
        return state.get() == TtsState.PAUSED;
    }

    public boolean isReady() {
        return ready;
    }

    /** Returns progress as a fraction 0.0 - 1.0 */
    public float getProgress() {
        if (totalChars == 0) return 0;
        return Math.min(1.0f, (float) spokenChars / totalChars);
    }

    public int getSpokenChars() { return spokenChars; }
    public int getTotalChars() { return totalChars; }

    public void shutdown() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
    }
}
