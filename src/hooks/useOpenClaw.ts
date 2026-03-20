import { useEffect, useRef, useState } from 'react';
import nodejs from 'nodejs-mobile-react-native';
import { NativeModules } from 'react-native';
import { OpenClawModule, openClawEmitter } from '../native/OpenClawModule';
import { Settings, ENC_KEY_API_KEY, ENC_KEY_BOT_TOKEN } from '../context/SettingsContext';
import EncryptedStorage from '../native/EncryptedStorageModule';

export type GatewayStatus = 'idle' | 'starting' | 'running' | 'error' | 'stopped';

export interface OpenClawState {
  status: GatewayStatus;
  logs: string[];
  start: (settings: Settings) => void;
  stop: () => void;
  updateConfig: (settings: Settings) => void;
}

export function useOpenClaw(): OpenClawState {
  const [status, setStatus] = useState<GatewayStatus>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const nodeStarted = useRef(false);

  const addLog = (line: string) =>
    setLogs((prev) => [line, ...prev].slice(0, 200));

  useEffect(() => {
    const nativeSub = openClawEmitter.addListener('onLog', (msg: string) => {
      addLog(msg);
    });

    const onNodeMessage = (msg: string) => {
      try {
        const parsed = JSON.parse(msg);
        const { type, payload, requestId } = parsed;

        if (type === 'log') { addLog(payload); return; }

        if (type === 'status') {
          setStatus(payload as GatewayStatus);
          if (payload === 'running') {
            nodejs.channel.send(JSON.stringify({ type: 'queryState' }));
          }
          return;
        }

        if (type === 'runPython') {
          NativeModules.PythonBridgeModule.runCode(payload.code, payload.dataDir)
            .then((output: string) => {
              nodejs.channel.send(JSON.stringify({
                type: 'nativeResult',
                payload: { output, error: null },
                requestId,
              }));
            })
            .catch((err: any) => {
              nodejs.channel.send(JSON.stringify({
                type: 'nativeResult',
                payload: { output: '', error: String(err?.message || err) },
                requestId,
              }));
            });
          return;
        }

        if (type === 'runSQLite') {
          const mod = NativeModules.SQLiteBridgeModule;
          const op = payload.mode === 'query'
            ? mod.query(payload.dbPath, payload.sql)
            : mod.exec(payload.dbPath, payload.sql);
          op.then((result: string) => {
            nodejs.channel.send(JSON.stringify({
              type: 'nativeResult',
              payload: { output: result, error: null },
              requestId,
            }));
          }).catch((err: any) => {
            nodejs.channel.send(JSON.stringify({
              type: 'nativeResult',
              payload: { output: '', error: String(err?.message || err) },
              requestId,
            }));
          });
          return;
        }

      } catch {
        addLog(msg);
      }
    };
    const nodeSub = nodejs.channel.addListener('message', onNodeMessage) as unknown as { remove: () => void } | null;

    return () => {
      nativeSub.remove();
      if (nodeSub && typeof (nodeSub as any).remove === 'function') {
        (nodeSub as any).remove();
      }
    };
  }, []);

  const start = async (settings: Settings) => {
    setStatus('starting');
    addLog('Starting OpenClaw service...');

    OpenClawModule.startService();
    const filesDir = await OpenClawModule.getFilesDir();

    // Read secrets directly from Keystore — never from React state
    const [apiKey, botToken] = await Promise.all([
      EncryptedStorage.getItem(ENC_KEY_API_KEY).catch(() => ''),
      EncryptedStorage.getItem(ENC_KEY_BOT_TOKEN).catch(() => ''),
    ]);

    const payload = {
      filesDir,
      ai: { provider: settings.ai.provider, model: settings.ai.model, apiKey: apiKey ?? '' },
      telegram: { chatId: settings.telegram.chatId, botToken: botToken ?? '' },
    };

    if (!nodeStarted.current) {
      nodejs.start('main.js');
      nodeStarted.current = true;
      setTimeout(() => {
        nodejs.channel.send(JSON.stringify({ type: 'init', payload }));
      }, 500);
    } else {
      nodejs.channel.send(JSON.stringify({ type: 'init', payload }));
    }
  };

  const stop = () => {
    addLog('Stopping OpenClaw service...');
    nodejs.channel.send(JSON.stringify({ type: 'stop' }));
    OpenClawModule.stopService();
    setStatus('stopped');
  };

  const updateConfig = async (settings: Settings) => {
    const [apiKey, botToken] = await Promise.all([
      EncryptedStorage.getItem(ENC_KEY_API_KEY).catch(() => ''),
      EncryptedStorage.getItem(ENC_KEY_BOT_TOKEN).catch(() => ''),
    ]);
    nodejs.channel.send(JSON.stringify({
      type: 'updateConfig',
      payload: {
        ai: { provider: settings.ai.provider, model: settings.ai.model, apiKey: apiKey ?? '' },
        telegram: { chatId: settings.telegram.chatId, botToken: botToken ?? '' },
      },
    }));
  };

  return { status, logs, start, stop, updateConfig };
}
