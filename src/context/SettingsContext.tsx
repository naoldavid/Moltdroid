import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import EncryptedStorage from '../native/EncryptedStorageModule';

// ── AI Provider Config ────────────────────────────────────────────────────────

export type AIProvider = 'anthropic' | 'openai' | 'google';

export const AI_PROVIDERS: Record<AIProvider, {
  name: string;
  icon: string;
  color: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyHint: string;
  needsKey: boolean;
  models: { id: string; name: string; desc: string }[];
}> = {
  anthropic: {
    name: 'Claude (Anthropic)',
    icon: '🧠',
    color: '#c678dd',
    keyLabel: 'Anthropic API Key',
    keyPlaceholder: 'sk-ant-••••••••••',
    keyHint: 'Get your key at console.anthropic.com',
    needsKey: true,
    models: [
      { id: 'claude-haiku-4-5-20251001',   name: 'Claude Haiku 4.5',    desc: 'Fastest · efficient' },
      { id: 'claude-sonnet-4-6',           name: 'Claude Sonnet 4.6',   desc: 'Best balance' },
      { id: 'claude-opus-4-6',             name: 'Claude Opus 4.6',     desc: 'Most capable' },
      { id: 'claude-sonnet-4-5-20250929',  name: 'Claude Sonnet 4.5',   desc: 'Prev gen · balanced' },
      { id: 'claude-opus-4-5-20251101',    name: 'Claude Opus 4.5',     desc: 'Prev gen · powerful' },
      { id: 'claude-opus-4-1-20250805',    name: 'Claude Opus 4.1',     desc: 'Legacy · powerful' },
      { id: 'claude-sonnet-4-20250514',    name: 'Claude Sonnet 4',     desc: 'Legacy · balanced' },
      { id: 'claude-opus-4-20250514',      name: 'Claude Opus 4',       desc: 'Legacy · capable' },
    ],
  },
  openai: {
    name: 'OpenAI / ChatGPT',
    icon: '🤖',
    color: '#10a37f',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-••••••••••',
    keyHint: 'Get your key at platform.openai.com',
    needsKey: true,
    models: [
      { id: 'gpt-5',              name: 'GPT-5',           desc: 'Latest · most capable' },
      { id: 'gpt-5-mini',         name: 'GPT-5 mini',      desc: 'Latest · fast' },
      { id: 'gpt-4.1',            name: 'GPT-4.1',         desc: 'Strong coding & instructions' },
      { id: 'gpt-4.1-mini',       name: 'GPT-4.1 mini',    desc: 'Fast & affordable' },
      { id: 'gpt-4.1-nano',       name: 'GPT-4.1 nano',    desc: 'Fastest · cheapest' },
      { id: 'gpt-4o',             name: 'GPT-4o',          desc: 'Multimodal · prev gen' },
      { id: 'gpt-4o-mini',        name: 'GPT-4o mini',     desc: 'Fast · prev gen' },
      { id: 'o4-mini',            name: 'o4-mini',         desc: 'Reasoning · efficient' },
      { id: 'o3',                 name: 'o3',              desc: 'Deep reasoning' },
    ],
  },
  google: {
    name: 'Google Gemini',
    icon: '✨',
    color: '#4285f4',
    keyLabel: 'Google AI API Key',
    keyPlaceholder: 'AIza••••••••••',
    keyHint: 'Get your key at aistudio.google.com',
    needsKey: true,
    models: [
      { id: 'gemini-2.5-pro',               name: 'Gemini 2.5 Pro',        desc: 'Most capable' },
      { id: 'gemini-2.5-flash',             name: 'Gemini 2.5 Flash',      desc: 'Fast & smart · recommended' },
      { id: 'gemini-2.5-flash-lite',        name: 'Gemini 2.5 Flash Lite', desc: 'Budget · fast' },
      { id: 'gemini-2.0-flash',             name: 'Gemini 2.0 Flash',      desc: 'Fast & multimodal' },
      { id: 'gemini-2.0-flash-lite',        name: 'Gemini 2.0 Flash Lite', desc: 'Cheapest 2.0' },
      { id: 'gemini-1.5-flash',             name: 'Gemini 1.5 Flash',      desc: 'Free tier · prev gen' },
      { id: 'gemini-1.5-pro',               name: 'Gemini 1.5 Pro',        desc: 'Quality · prev gen' },
    ],
  },
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AIConfig {
  provider: AIProvider;
  model: string;
  // NOTE: apiKey is NEVER stored in React state.
  // hasApiKey tells us if a key is saved in encrypted storage.
  hasApiKey: boolean;
}

export interface Settings {
  onboarded: boolean;
  termsAccepted: boolean;
  ai: AIConfig;
  telegram: {
    // NOTE: botToken is NEVER stored in React state.
    // hasToken tells us if a token is saved in encrypted storage.
    hasToken: boolean;
    chatId?: string;
  };
  filesDir: string;
}

const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  termsAccepted: false,
  ai: {
    provider: 'google',
    model: 'gemini-2.5-flash',
    hasApiKey: false,
  },
  telegram: { hasToken: false },
  filesDir: '',
};

// Encrypted storage keys — only used in SettingsContext and useOpenClaw
export const ENC_KEY_API_KEY   = 'ai_api_key';
export const ENC_KEY_BOT_TOKEN = 'telegram_bot_token';

const STORAGE_KEY = '@moltdroid/settings_v3';

// ── Context ───────────────────────────────────────────────────────────────────

interface SettingsContextValue {
  settings: Settings;
  loaded: boolean;
  /** Save non-sensitive settings. To save API key/token, use saveApiKey / saveBotToken. */
  save: (patch: Partial<Settings>) => Promise<void>;
  /** Saves the API key to encrypted storage only. Never stored in React state. */
  saveApiKey: (key: string) => Promise<void>;
  /** Saves the bot token to encrypted storage only. Never stored in React state. */
  saveBotToken: (token: string) => Promise<void>;
  reset: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  save: async () => {},
  saveApiKey: async () => {},
  saveBotToken: async () => {},
  reset: async () => {},
});

// ── Provider ──────────────────────────────────────────────────────────────────

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Check if encrypted keys exist (without decrypting them)
        const [apiKey, botToken] = await Promise.all([
          EncryptedStorage.getItem(ENC_KEY_API_KEY).catch(() => null),
          EncryptedStorage.getItem(ENC_KEY_BOT_TOKEN).catch(() => null),
        ]);

        // Load non-sensitive settings from AsyncStorage
        let parsed: Partial<Settings> = {};
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          try { parsed = JSON.parse(raw); } catch {}
        } else {
          // Migrate from old storage keys
          for (const oldKey of ['@moltdroid/settings_v2', '@moltdroid/settings']) {
            const oldRaw = await AsyncStorage.getItem(oldKey);
            if (oldRaw) {
              try {
                const old = JSON.parse(oldRaw) as Record<string, unknown>;
                parsed = old as Partial<Settings>;
                // Migrate plaintext apiKey if present and not yet in encrypted storage
                if (!apiKey) {
                  const oldApiKey = (old.ai as any)?.apiKey || (old as any).apiKey || '';
                  if (oldApiKey) await EncryptedStorage.setItem(ENC_KEY_API_KEY, oldApiKey);
                }
                if (!botToken) {
                  const oldToken = (old.telegram as any)?.botToken || '';
                  if (oldToken) await EncryptedStorage.setItem(ENC_KEY_BOT_TOKEN, oldToken);
                }
              } catch {}
              break;
            }
          }
        }

        setSettings({
          ...DEFAULT_SETTINGS,
          ...parsed,
          ai: {
            ...DEFAULT_SETTINGS.ai,
            ...(typeof parsed.ai === 'object' && parsed.ai !== null ? parsed.ai as Partial<AIConfig> : {}),
            hasApiKey: !!apiKey,
            // Explicitly strip any plaintext apiKey that leaked from old migrations
          },
          telegram: {
            ...(typeof parsed.telegram === 'object' && parsed.telegram !== null ? parsed.telegram : {}),
            hasToken: !!botToken,
          },
        });
      } catch {}
      setLoaded(true);
    })();
  }, []);

  const persistNonSensitive = (next: Settings) => {
    // Strip any sensitive fields before persisting
    const toStore: Record<string, unknown> = {
      ...next,
      ai: { provider: next.ai.provider, model: next.ai.model, hasApiKey: next.ai.hasApiKey },
      telegram: { hasToken: next.telegram.hasToken, chatId: next.telegram.chatId },
    };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toStore)).catch(() => {});
  };

  const save = useCallback(async (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next: Settings = {
        ...prev,
        ...patch,
        ai: patch.ai ? { ...prev.ai, ...patch.ai } : prev.ai,
        telegram: patch.telegram ? { ...prev.telegram, ...patch.telegram } : prev.telegram,
      };
      persistNonSensitive(next);
      return next;
    });
  }, []);

  const saveApiKey = useCallback(async (key: string) => {
    const trimmed = key.trim();
    if (trimmed) {
      await EncryptedStorage.setItem(ENC_KEY_API_KEY, trimmed);
    } else {
      await EncryptedStorage.deleteItem(ENC_KEY_API_KEY);
    }
    setSettings((prev) => {
      const next = { ...prev, ai: { ...prev.ai, hasApiKey: !!trimmed } };
      persistNonSensitive(next);
      return next;
    });
  }, []);

  const saveBotToken = useCallback(async (token: string) => {
    const trimmed = token.trim();
    if (trimmed) {
      await EncryptedStorage.setItem(ENC_KEY_BOT_TOKEN, trimmed);
    } else {
      await EncryptedStorage.deleteItem(ENC_KEY_BOT_TOKEN);
    }
    setSettings((prev) => {
      const next = { ...prev, telegram: { ...prev.telegram, hasToken: !!trimmed } };
      persistNonSensitive(next);
      return next;
    });
  }, []);

  const reset = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    await AsyncStorage.removeItem('@moltdroid/settings_v2');
    await AsyncStorage.removeItem('@moltdroid/settings');
    await EncryptedStorage.clear().catch(() => {});
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, loaded, save, saveApiKey, saveBotToken, reset }}>
      {children}
    </SettingsContext.Provider>
  );
}

export const useSettings = () => useContext(SettingsContext);
