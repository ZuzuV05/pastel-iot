import React, { useState, useRef, useCallback } from 'react';
import { useMqtt } from '../mqttContext';

type CommandResult = {
  recognized: string;
  action: string;
  success: boolean;
};

// Normalize Indonesian text: lowercase, remove punctuation
const normalize = (text: string) =>
  text.toLowerCase().replace(/[^\w\s]/g, '').trim();

export const VoiceControl: React.FC = () => {
  const { publish, state } = useMqtt();
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const parseAndExecute = useCallback(
    (text: string): CommandResult => {
      const t = normalize(text);

      // ── Helpers ──────────────────────────────────────────────
      const contains = (...words: string[]) => words.some((w) => t.includes(w));
      const isOn  = contains('nyala', 'nyalakan', 'hidupkan', 'hidup', 'on', 'aktifkan');
      const isOff = contains('matikan', 'mati', 'padamkan', 'off');

      const lampNum = (n: string) => {
        const map: Record<string, string> = {
          '1': 'lampu1', satu: 'lampu1',
          '2': 'lampu2', dua: 'lampu2',
          '3': 'lampu3', tiga: 'lampu3',
          '4': 'lampu4', empat: 'lampu4',
        };
        return map[n] ?? null;
      };

      // ── Sensor queries ────────────────────────────────────────
      if (contains('suhu', 'temperatur', 'temperature')) {
        return {
          recognized: text,
          action: `🌡️ Suhu saat ini: ${state.temperature}°C`,
          success: true,
        };
      }

      if (contains('kelembab', 'humid')) {
        return {
          recognized: text,
          action: `💧 Kelembapan saat ini: ${state.humidity}%`,
          success: true,
        };
      }

      // ── Variasi ───────────────────────────────────────────────
      if (contains('variasi 1', 'variasi1', 'variasi satu', 'efek 1', 'efek satu')) {
        publish('smarthome/variasi', 'VARIASI1');
        return { recognized: text, action: '✨ Variasi 1 (Sequential Loop) diaktifkan', success: true };
      }

      if (contains('variasi 2', 'variasi2', 'variasi dua', 'efek 2', 'efek dua')) {
        publish('smarthome/variasi', 'VARIASI2');
        return { recognized: text, action: '✨ Variasi 2 (Gradient Stack) diaktifkan', success: true };
      }

      if (contains('stop efek', 'hentikan efek', 'stop variasi', 'hentikan variasi')) {
        publish('smarthome/variasi', 'STOP');
        return { recognized: text, action: '⏹️ Efek cahaya dihentikan', success: true };
      }

      // ── All lamps ON / OFF ────────────────────────────────────
      const allKeywords = ['semua', 'seluruh', 'all', 'semua lampu'];
      if (allKeywords.some((k) => t.includes(k))) {
        if (isOn) {
          ['lampu1', 'lampu2', 'lampu3', 'lampu4'].forEach((l) =>
            publish(`smarthome/${l}`, 'ON')
          );
          return { recognized: text, action: '💡 Semua lampu dinyalakan', success: true };
        }
        if (isOff) {
          ['lampu1', 'lampu2', 'lampu3', 'lampu4'].forEach((l) =>
            publish(`smarthome/${l}`, 'OFF')
          );
          return { recognized: text, action: '🌙 Semua lampu dimatikan', success: true };
        }
      }

      // ── Single lamp ───────────────────────────────────────────
      for (const [token, key] of Object.entries({
        '1': 'lampu1', satu: 'lampu1',
        '2': 'lampu2', dua: 'lampu2',
        '3': 'lampu3', tiga: 'lampu3',
        '4': 'lampu4', empat: 'lampu4',
      })) {
        // Match "lampu 1", "lampu satu", or just the number after nyala/mati
        const patterns = [
          `lampu ${token}`,
          `lampu${token}`,
          new RegExp(`(nyala|mati|hidupkan|matikan|padamkan)\\s+(lampu\\s*)?${token}`),
        ];
        const matched = patterns.some((p) =>
          typeof p === 'string' ? t.includes(p) : p.test(t)
        );

        if (matched) {
          if (isOn) {
            publish(`smarthome/${key}`, 'ON');
            const num = key.replace('lampu', '');
            return { recognized: text, action: `💡 Lampu ${num} dinyalakan`, success: true };
          }
          if (isOff) {
            publish(`smarthome/${key}`, 'OFF');
            const num = key.replace('lampu', '');
            return { recognized: text, action: `🌙 Lampu ${num} dimatikan`, success: true };
          }
        }
      }

      // ── Generic "nyalakan lampu" / "matikan lampu" (no number = all) ──
      if (contains('lampu')) {
        if (isOn) {
          ['lampu1', 'lampu2', 'lampu3', 'lampu4'].forEach((l) =>
            publish(`smarthome/${l}`, 'ON')
          );
          return { recognized: text, action: '💡 Semua lampu dinyalakan', success: true };
        }
        if (isOff) {
          ['lampu1', 'lampu2', 'lampu3', 'lampu4'].forEach((l) =>
            publish(`smarthome/${l}`, 'OFF')
          );
          return { recognized: text, action: '🌙 Semua lampu dimatikan', success: true };
        }
      }

      return {
        recognized: text,
        action: '❓ Perintah tidak dikenali. Coba: "Nyalakan lampu 1" atau "Berapa suhu"',
        success: false,
      };
    },
    [publish, state.temperature, state.humidity]
  );

  const startListening = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setError('Browser tidak mendukung Web Speech API. Gunakan Chrome atau Edge.');
      return;
    }

    setError(null);
    setResult(null);
    setTranscript('');

    const recognition: SpeechRecognition = new SpeechRecognition();
    recognition.lang = 'id-ID';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognitionRef.current = recognition;

    recognition.onstart = () => setIsListening(true);

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      setTranscript(final || interim);
      if (final) {
        const res = parseAndExecute(final);
        setResult(res);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const msgs: Record<string, string> = {
        'no-speech': 'Tidak ada suara terdeteksi. Coba lagi.',
        'audio-capture': 'Mikrofon tidak ditemukan.',
        'not-allowed': 'Akses mikrofon ditolak. Izinkan di pengaturan browser.',
        'network': 'Koneksi internet diperlukan untuk speech recognition.',
      };
      setError(msgs[event.error] ?? `Error: ${event.error}`);
      setIsListening(false);
    };

    recognition.onend = () => setIsListening(false);

    recognition.start();
  }, [parseAndExecute]);

  const stopListening = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
  };

  // Example commands shown in UI
  const examples = [
    'Nyalakan lampu 1',
    'Matikan lampu 3',
    'Nyalakan semua lampu',
    'Matikan lampu',
    'Berapa suhu?',
    'Berapa kelembapan?',
    'Nyalakan Variasi 1',
    'Nyalakan Variasi 2',
    'Stop efek',
  ];

  return (
    <div className="bg-white/40 border border-white rounded-[2.5rem] p-6 backdrop-blur-md">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-md font-black text-slate-800">Voice Control</h3>
          <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mt-0.5">
            Perintah Suara
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isListening && (
            <span className="flex h-2 w-2 rounded-full bg-red-400 animate-pulse" />
          )}
          <span
            className={`text-[10px] font-bold uppercase ${
              isListening ? 'text-red-500' : 'text-slate-400'
            }`}
          >
            {isListening ? 'Mendengarkan...' : 'Siap'}
          </span>
        </div>
      </div>

      {/* Mic Button */}
      <div className="flex flex-col items-center gap-4 mb-5">
        <button
          onClick={isListening ? stopListening : startListening}
          className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-lg focus:outline-none
            ${
              isListening
                ? 'bg-gradient-to-br from-red-400 to-pink-500 shadow-red-200/60 scale-110'
                : 'bg-gradient-to-br from-pink-400 to-rose-400 shadow-pink-200/60 hover:scale-105'
            }`}
          title={isListening ? 'Stop' : 'Mulai bicara'}
        >
          {/* Pulse rings when listening */}
          {isListening && (
            <>
              <span className="absolute inset-0 rounded-full bg-red-400/30 animate-ping" />
              <span className="absolute inset-[-8px] rounded-full border-2 border-red-300/40 animate-ping [animation-delay:0.3s]" />
            </>
          )}
          {/* Mic icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-8 h-8 text-white relative z-10"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 14.93A7.001 7.001 0 0 1 5 9H3a9.001 9.001 0 0 0 8 8.938V21H9v2h6v-2h-2v-3.07A9.001 9.001 0 0 0 21 9h-2a7 7 0 0 1-6 6.93z" />
          </svg>
        </button>
        <p className="text-xs text-slate-500 text-center">
          {isListening
            ? 'Berbicara... klik untuk stop'
            : 'Klik mikrofon lalu ucapkan perintah'}
        </p>
      </div>

      {/* Live transcript */}
      {(transcript || isListening) && (
        <div className="mb-4 p-3 bg-white/60 border border-slate-100 rounded-2xl min-h-[48px]">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
            Mendengar
          </p>
          <p className="text-sm font-semibold text-slate-700 italic">
            {transcript || (
              <span className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
              </span>
            )}
          </p>
        </div>
      )}

      {/* Result */}
      {result && (
        <div
          className={`mb-4 p-3 rounded-2xl border text-sm font-semibold ${
            result.success
              ? 'bg-emerald-50/70 border-emerald-200 text-emerald-700'
              : 'bg-amber-50/70 border-amber-200 text-amber-700'
          }`}
        >
          <p className="text-[10px] font-bold uppercase tracking-widest mb-1 opacity-60">
            Hasil
          </p>
          {result.action}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-2xl bg-red-50/70 border border-red-200 text-red-600 text-sm font-semibold">
          ⚠️ {error}
        </div>
      )}

      {/* Example commands */}
      <div>
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
          Contoh Perintah
        </p>
        <div className="flex flex-wrap gap-2">
          {examples.map((ex) => (
            <span
              key={ex}
              className="px-2.5 py-1 rounded-full bg-white/70 border border-slate-100 text-[10px] font-semibold text-slate-500 shadow-sm"
            >
              "{ex}"
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
