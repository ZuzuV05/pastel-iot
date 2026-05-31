import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import { AppState, LogEntry, RelayStatus } from './types';

interface MqttContextType {
  client: MqttClient | null;
  state: AppState;
  publish: (topic: string, message: string) => void;
}

const defaultState: AppState = {
  temperature: 29.0,
  humidity: 75,
  relays: {
    lampu1: 'OFF',
    lampu2: 'OFF',
    lampu3: 'OFF',
    lampu4: 'OFF',
  },
  variation: 'STOP',
  status: {
    esp32Online: false,
    mqttConnected: false,
    telegramConnected: true,
    sensorActive: false,
  },
  logs: [],
  lastUpdate: new Date(),
};

const MqttContext = createContext<MqttContextType>({
  client: null,
  state: defaultState,
  publish: () => {},
});

export const useMqtt = () => useContext(MqttContext);

const BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';

// Extract "lampuX" from "smarthome/lampuX" or "smarthome/lampuX/status"
const getLampKey = (topic: string): keyof AppState['relays'] | null => {
  const match = topic.match(/smarthome\/(lampu[1-4])/);
  return match ? (match[1] as keyof AppState['relays']) : null;
};

export const MqttProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [client, setClient] = useState<MqttClient | null>(null);
  const [state, setState] = useState<AppState>(defaultState);
  const logsRef = useRef<LogEntry[]>([]);

  const addLog = (message: string) => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substr(2, 9),
      message,
      timestamp: new Date(),
    };
    logsRef.current = [newLog, ...logsRef.current].slice(0, 50);
    setState((prev) => ({ ...prev, logs: logsRef.current, lastUpdate: new Date() }));
  };

  useEffect(() => {
    addLog('System initialized.');

    const mqttClient = mqtt.connect(BROKER_URL, {
      reconnectPeriod: 5000,
    });

    setClient(mqttClient);

    mqttClient.on('connect', () => {
      setState((prev) => ({
        ...prev,
        status: { ...prev.status, mqttConnected: true },
        lastUpdate: new Date(),
      }));
      addLog('MQTT Connected to broker');
      mqttClient.subscribe('smarthome/#');
    });

    mqttClient.on('reconnect', () => {
      addLog('MQTT Reconnecting...');
    });

    mqttClient.on('offline', () => {
      setState((prev) => ({
        ...prev,
        status: { ...prev.status, mqttConnected: false, esp32Online: false },
        lastUpdate: new Date(),
      }));
      addLog('MQTT Offline');
    });

    mqttClient.on('error', (err) => {
      addLog(`MQTT Error: ${err.message}`);
    });

    mqttClient.on('message', (topic, payload) => {
      const message = payload.toString();

      // ── Suhu ────────────────────────────────────────────────────
      if (topic === 'smarthome/suhu') {
        const val = parseFloat(message);
        if (!isNaN(val)) {
          setState((prev) => ({
            ...prev,
            temperature: val,
            // First sensor reading → mark ESP32 & sensor as active
            status: { ...prev.status, esp32Online: true, sensorActive: true },
            lastUpdate: new Date(),
          }));
        }
        return;
      }

      // ── Kelembaban ───────────────────────────────────────────────
      if (topic === 'smarthome/kelembaban') {
        const val = parseFloat(message);
        if (!isNaN(val)) {
          setState((prev) => ({
            ...prev,
            humidity: val,
            status: { ...prev.status, esp32Online: true, sensorActive: true },
            lastUpdate: new Date(),
          }));
        }
        return;
      }

      // ── Relay status ─────────────────────────────────────────────
      // Handles both "smarthome/lampuX" (command echo) and
      // "smarthome/lampuX/status" (ESP32 confirmation)
      const lampKey = getLampKey(topic);
      if (lampKey) {
        const normalized = message.toUpperCase() as RelayStatus;
        setState((prev) => {
          if (prev.relays[lampKey] !== normalized) {
            const newLog: LogEntry = {
              id: Math.random().toString(36).substr(2, 9),
              message: `Status ${lampKey} → ${normalized}`,
              timestamp: new Date(),
            };
            logsRef.current = [newLog, ...logsRef.current].slice(0, 50);
            return {
              ...prev,
              relays: { ...prev.relays, [lampKey]: normalized },
              logs: logsRef.current,
              lastUpdate: new Date(),
            };
          }
          return { ...prev, lastUpdate: new Date() };
        });
        return;
      }

      // ── Variasi ───────────────────────────────────────────────────
      // Handles both "smarthome/variasi" and "smarthome/variasi/status"
      if (topic === 'smarthome/variasi' || topic === 'smarthome/variasi/status') {
        setState((prev) => {
          if (prev.variation !== message) {
            const newLog: LogEntry = {
              id: Math.random().toString(36).substr(2, 9),
              message: message === 'STOP' ? 'Variasi stopped' : `${message} Activated`,
              timestamp: new Date(),
            };
            logsRef.current = [newLog, ...logsRef.current].slice(0, 50);
            return {
              ...prev,
              variation: message as any,
              logs: logsRef.current,
              lastUpdate: new Date(),
            };
          }
          return { ...prev, lastUpdate: new Date() };
        });
        return;
      }

      // ── ESP32 online/offline status ──────────────────────────────
      if (topic === 'smarthome/status') {
        try {
          const parsedStatus = JSON.parse(message);
          setState((prev) => ({
            ...prev,
            status: { ...prev.status, ...parsedStatus },
            lastUpdate: new Date(),
          }));
        } catch (e) {
          const upperMsg = message.toUpperCase();
          setState((prev) => {
            if (upperMsg === 'ONLINE' || upperMsg === 'CONNECTED') {
              return { ...prev, status: { ...prev.status, esp32Online: true }, lastUpdate: new Date() };
            } else if (upperMsg === 'OFFLINE' || upperMsg === 'DISCONNECTED') {
              return { ...prev, status: { ...prev.status, esp32Online: false }, lastUpdate: new Date() };
            }
            return { ...prev, lastUpdate: new Date() };
          });
        }
        return;
      }
    });

    return () => {
      mqttClient.end();
    };
  }, []);

  const publish = (topic: string, message: string) => {
    if (client && client.connected) {
      client.publish(topic, message);

      if (topic.startsWith('smarthome/lampu') && !topic.includes('/status')) {
        const lampKey = getLampKey(topic);
        if (lampKey) {
          setState((prev) => ({
            ...prev,
            relays: { ...prev.relays, [lampKey]: message as RelayStatus },
            lastUpdate: new Date(),
          }));
          addLog(`Command sent: ${lampKey} → ${message}`);
        }
      } else if (topic === 'smarthome/variasi') {
        setState((prev) => ({
          ...prev,
          variation: message as any,
          lastUpdate: new Date(),
        }));
        addLog(`Command sent: Variation → ${message}`);
      }
    } else {
      addLog('MQTT not connected — UI updated locally for testing.');
      if (topic.startsWith('smarthome/lampu') && !topic.includes('/status')) {
        const lampKey = getLampKey(topic);
        if (lampKey) {
          setState((prev) => ({
            ...prev,
            relays: { ...prev.relays, [lampKey]: message as RelayStatus },
            lastUpdate: new Date(),
          }));
        }
      } else if (topic === 'smarthome/variasi') {
        setState((prev) => ({
          ...prev,
          variation: message as any,
          lastUpdate: new Date(),
        }));
      }
    }
  };

  return (
    <MqttContext.Provider value={{ client, state, publish }}>
      {children}
    </MqttContext.Provider>
  );
};
