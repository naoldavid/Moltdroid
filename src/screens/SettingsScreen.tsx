import React, { useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import nodejs from 'nodejs-mobile-react-native';
import { AI_PROVIDERS, type AIProvider, useSettings, ENC_KEY_API_KEY, ENC_KEY_BOT_TOKEN } from '../context/SettingsContext';
import EncryptedStorage from '../native/EncryptedStorageModule';
import { OpenClawModule } from '../native/OpenClawModule';

const T = {
  bg: '#000000', surface: '#111111', surface2: '#1C1C1E', border: '#2C2C2E',
  red: '#E8202A', green: '#30D158', amber: '#FF9F0A',
  text: '#FFFFFF', text2: '#8E8E93', text3: '#48484A',
};

interface Props { onBack: () => void; onResetOnboarding: () => void }

const PROVIDER_ORDER: AIProvider[] = ['google', 'anthropic', 'openai'];

export default function SettingsScreen({ onBack, onResetOnboarding }: Props) {
  const { settings, save, saveApiKey, saveBotToken } = useSettings();
  const [provider, setProvider] = useState<AIProvider>(settings.ai.provider);
  const [model, setModel]       = useState(settings.ai.model);
  // Write-only inputs — empty by default, only set if user is replacing the key
  const [newApiKey, setNewApiKey]   = useState('');
  const [newBotToken, setNewBotToken] = useState('');
  const [saved, setSaved]           = useState(false);

  const pc = AI_PROVIDERS[provider];

  const handleProviderChange = (p: AIProvider) => {
    setProvider(p);
    setModel(AI_PROVIDERS[p].models[0].id);
    setNewApiKey('');
  };

  const handleSave = async () => {
    await save({ ai: { ...settings.ai, provider, model } });

    // Only update secrets if user actually typed a new value
    if (newApiKey.trim()) await saveApiKey(newApiKey.trim());
    if (newBotToken.trim()) await saveBotToken(newBotToken.trim());

    // Push live config update to running Node.js agent — read secrets fresh from Keystore
    const [apiKey, botToken] = await Promise.all([
      EncryptedStorage.getItem(ENC_KEY_API_KEY).catch(() => ''),
      EncryptedStorage.getItem(ENC_KEY_BOT_TOKEN).catch(() => ''),
    ]);
    nodejs.channel.send(JSON.stringify({
      type: 'updateConfig',
      payload: {
        ai: { provider, model, apiKey: apiKey ?? '' },
        telegram: { chatId: settings.telegram.chatId, botToken: botToken ?? '' },
      },
    }));

    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    setNewApiKey('');
    setNewBotToken('');
  };

  const handleReset = () => {
    Alert.alert(
      'Reset App',
      'This will clear all settings, API keys, and show the onboarding screens again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset Everything',
          style: 'destructive',
          onPress: async () => {
            await save({ onboarded: false, termsAccepted: false, ai: { provider: 'google', model: 'gemini-2.5-flash', hasApiKey: false }, telegram: { hasToken: false } });
            onResetOnboarding();
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Settings</Text>
          <TouchableOpacity onPress={handleSave} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={[styles.saveText, saved && styles.savedText]}>{saved ? 'Saved ✓' : 'Save'}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>

          {/* ── AI Provider ── */}
          <SectionHeader title="AI Provider" />
          <View style={styles.providerRow}>
            {PROVIDER_ORDER.map((p) => {
              const pcc = AI_PROVIDERS[p];
              const active = p === provider;
              return (
                <TouchableOpacity
                  key={p}
                  style={[styles.providerChip, active && { borderColor: pcc.color, backgroundColor: T.surface2 }]}
                  onPress={() => handleProviderChange(p)}
                  activeOpacity={0.75}>
                  <Text style={styles.chipIcon}>{pcc.icon}</Text>
                  <Text style={[styles.chipLabel, active && { color: pcc.color }]}>
                    {p === 'anthropic' ? 'Claude' : p === 'openai' ? 'OpenAI' : 'Gemini'}
                  </Text>
                  {active && <View style={[styles.chipDot, { backgroundColor: pcc.color }]} />}
                </TouchableOpacity>
              );
            })}
          </View>

          <FieldLabel>Model</FieldLabel>
          <View style={styles.modelCard}>
            {(pc?.models ?? []).map((m, i) => (
              <TouchableOpacity
                key={m.id}
                style={[styles.modelRow, i < (pc?.models.length ?? 0) - 1 && styles.modelRowDivider]}
                onPress={() => setModel(m.id)}
                activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.modelName, model === m.id && { color: pc.color }]}>{m.name}</Text>
                  <Text style={styles.modelDesc}>{m.desc}</Text>
                </View>
                <View style={[styles.radio, model === m.id && { borderColor: pc.color }]}>
                  {model === m.id && <View style={[styles.radioDot, { backgroundColor: pc.color }]} />}
                </View>
              </TouchableOpacity>
            ))}
          </View>

          {/* API Key — write-only */}
          {pc.needsKey && (
            <>
              <FieldLabel>{pc.keyLabel}</FieldLabel>
              {/* Status indicator */}
              <View style={[styles.keyStatus, settings.ai.hasApiKey && styles.keyStatusSet]}>
                <Text style={[styles.keyStatusIcon]}>{settings.ai.hasApiKey ? '🔒' : '⚠️'}</Text>
                <Text style={[styles.keyStatusText, { color: settings.ai.hasApiKey ? T.green : T.amber }]}>
                  {settings.ai.hasApiKey ? 'Key stored securely in Android Keystore' : 'No API key configured'}
                </Text>
              </View>
              <TextInput
                style={styles.input}
                value={newApiKey}
                onChangeText={setNewApiKey}
                placeholder={settings.ai.hasApiKey ? 'Enter new key to replace…' : pc.keyPlaceholder}
                placeholderTextColor={T.text3}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <Text style={styles.fieldHint}>{pc.keyHint} · Your key is never shown after saving</Text>
            </>
          )}

          {/* ── Telegram ── */}
          <SectionHeader title="Telegram" />
          <FieldLabel>Bot Token</FieldLabel>
          <View style={[styles.keyStatus, settings.telegram.hasToken && styles.keyStatusSet]}>
            <Text style={styles.keyStatusIcon}>{settings.telegram.hasToken ? '🔒' : '⚠️'}</Text>
            <Text style={[styles.keyStatusText, { color: settings.telegram.hasToken ? T.green : T.amber }]}>
              {settings.telegram.hasToken ? 'Token stored securely in Android Keystore' : 'No bot token configured'}
            </Text>
          </View>
          <TextInput
            style={styles.input}
            value={newBotToken}
            onChangeText={setNewBotToken}
            placeholder={settings.telegram.hasToken ? 'Enter new token to replace…' : '123456789:AAF...'}
            placeholderTextColor={T.text3}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Text style={styles.fieldHint}>Chat ID is detected automatically · Token never shown after saving</Text>

          {/* ── System ── */}
          <SectionHeader title="System" />
          <View style={styles.actionCard}>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => OpenClawModule.requestBatteryOptimizationWhitelist()}
              activeOpacity={0.7}>
              <Text style={styles.actionIcon}>🔋</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionTitle}>Battery Whitelist</Text>
                <Text style={styles.actionDesc}>Keep agent alive when screen is off</Text>
              </View>
              <Text style={styles.actionChevron}>›</Text>
            </TouchableOpacity>
          </View>

          {/* ── Danger Zone ── */}
          <SectionHeader title="Danger Zone" />
          <TouchableOpacity style={styles.dangerCard} onPress={handleReset} activeOpacity={0.8}>
            <Text style={styles.dangerIcon}>⚠️</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.dangerTitle}>Reset & Re-run Onboarding</Text>
              <Text style={styles.dangerDesc}>Clears all settings and API keys permanently</Text>
            </View>
          </TouchableOpacity>

          {/* Attribution */}
          <View style={styles.attribution}>
            <Text style={styles.attributionHex}>⬡</Text>
            <Text style={styles.attributionText}>MoltDroid · Made by Naol Haase</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <Text style={shStyles.title}>{title}</Text>;
}
function FieldLabel({ children }: { children: string }) {
  return <Text style={shStyles.label}>{children}</Text>;
}
const shStyles = StyleSheet.create({
  title: { color: T.text2, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 28, marginBottom: 10 },
  label: { color: T.text2, fontSize: 13, marginBottom: 6, marginTop: 12 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  backText: { color: T.text2, fontSize: 15, minWidth: 60 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: T.text },
  saveText: { color: T.red, fontSize: 15, fontWeight: '700', minWidth: 60, textAlign: 'right' },
  savedText: { color: T.green },

  body: { paddingHorizontal: 20, paddingBottom: 32 },

  providerRow: { flexDirection: 'row', gap: 10 },
  providerChip: {
    flex: 1, backgroundColor: T.surface, borderRadius: 12,
    borderWidth: 1.5, borderColor: T.border, paddingVertical: 14,
    alignItems: 'center', gap: 6, position: 'relative',
  },
  chipIcon: { fontSize: 24 },
  chipLabel: { color: T.text2, fontSize: 12, fontWeight: '600' },
  chipDot: { position: 'absolute', top: 6, right: 6, width: 6, height: 6, borderRadius: 3 },

  modelCard: {
    backgroundColor: T.surface, borderRadius: 14,
    borderWidth: 1, borderColor: T.border, overflow: 'hidden',
  },
  modelRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 13, paddingHorizontal: 14, gap: 10,
  },
  modelRowDivider: { borderBottomWidth: 1, borderBottomColor: T.border },
  modelName: { color: T.text, fontSize: 14, fontWeight: '500' },
  modelDesc: { color: T.text2, fontSize: 12, marginTop: 2 },
  radio: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: T.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioDot: { width: 9, height: 9, borderRadius: 5 },

  // Key status indicator
  keyStatus: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: T.surface, borderRadius: 10,
    borderWidth: 1, borderColor: T.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8,
  },
  keyStatusSet: { borderColor: 'rgba(48,209,88,0.3)' },
  keyStatusIcon: { fontSize: 15 },
  keyStatusText: { fontSize: 13, fontWeight: '500', flex: 1 },

  input: {
    backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 13,
    color: T.text, fontSize: 14, fontFamily: 'monospace',
  },
  fieldHint: { color: T.text3, fontSize: 12, marginTop: 6, lineHeight: 18 },

  actionCard: {
    backgroundColor: T.surface, borderRadius: 14,
    borderWidth: 1, borderColor: T.border, overflow: 'hidden',
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  actionIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  actionTitle: { color: T.text, fontSize: 15, fontWeight: '500' },
  actionDesc: { color: T.text2, fontSize: 12, marginTop: 2 },
  actionChevron: { color: T.text3, fontSize: 20 },

  dangerCard: {
    backgroundColor: 'rgba(232,32,42,0.06)', borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(232,32,42,0.25)',
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16,
  },
  dangerIcon: { fontSize: 20 },
  dangerTitle: { color: T.red, fontSize: 15, fontWeight: '600' },
  dangerDesc: { color: T.text3, fontSize: 12, marginTop: 2 },

  attribution: {
    alignItems: 'center', paddingVertical: 28, gap: 6,
  },
  attributionHex: { fontSize: 18, color: T.text3, opacity: 0.4 },
  attributionText: { color: T.text3, fontSize: 11, opacity: 0.5 },
});
