import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, KeyboardAvoidingView, Platform, StyleSheet, Text,
  TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AI_PROVIDERS, useSettings } from '../../context/SettingsContext';

const T = {
  bg: '#000000', surface: '#111111', border: '#2C2C2E',
  red: '#E8202A', green: '#30D158', text: '#FFFFFF', text2: '#8E8E93', text3: '#48484A',
};

interface Props { onNext: () => void; onBack: () => void }

export default function ApiKeyScreen({ onNext, onBack }: Props) {
  const { settings, saveApiKey } = useSettings();
  const provider = settings.ai.provider;
  const cfg = AI_PROVIDERS[provider];

  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);

  const handleNext = async () => {
    if (cfg.needsKey) {
      const trimmed = key.trim();
      if (trimmed.length < 8) {
        setError('API key must be at least 8 characters.');
        return;
      }
      await saveApiKey(trimmed);
    }
    onNext();
  };

  const handleSkip = async () => {
    onNext();
  };

  return (
    <Animated.View style={[{ flex: 1 }, { opacity: fadeAnim }]}>
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.stepText}>2 / 4</Text>
        </View>

        <View style={styles.body}>
          {/* Provider badge */}
          <View style={[styles.badge, { borderColor: cfg.color }]}>
            <Text style={styles.badgeIcon}>{cfg.icon}</Text>
            <Text style={[styles.badgeName, { color: cfg.color }]}>{cfg.name}</Text>
          </View>

          <Text style={styles.title}>{cfg.keyLabel}</Text>
          <Text style={styles.subtitle}>
            {cfg.needsKey
              ? 'Your key is encrypted in Android Keystore and never accessible to the app UI or third-party skills.'
              : cfg.keyHint}
          </Text>

          {/* Security guarantee */}
          <View style={styles.securityCard}>
            <Text style={styles.securityTitle}>🔒 Hardware-encrypted · Write-only</Text>
            <Text style={styles.securityText}>
              Once saved, your key is sealed in Android's hardware-backed Keystore. It can never be read or displayed again — only used internally when the agent calls the AI API.
            </Text>
          </View>

          {cfg.needsKey && (
            <View style={styles.inputGroup}>
              <View style={[styles.inputWrap, !!error && styles.inputWrapError]}>
                <TextInput
                  style={styles.input}
                  value={key}
                  onChangeText={(t) => { setKey(t); setError(''); }}
                  placeholder={cfg.keyPlaceholder}
                  placeholderTextColor={T.text3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
              </View>
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
              <Text style={styles.hint}>{cfg.keyHint}</Text>
            </View>
          )}
        </View>

        <View style={styles.footer}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: cfg.color }]} onPress={handleNext} activeOpacity={0.85}>
            <Text style={styles.btnText}>
              {cfg.needsKey ? 'Save & Continue' : 'Continue'}
            </Text>
          </TouchableOpacity>
          {cfg.needsKey && (
            <TouchableOpacity onPress={handleSkip} style={styles.skipBtn}>
              <Text style={styles.skipText}>Skip for now</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 24, paddingVertical: 14,
  },
  backText: { color: T.text2, fontSize: 15 },
  stepText: { color: T.text3, fontSize: 13 },

  body: { flex: 1, paddingHorizontal: 24, paddingTop: 8, gap: 18 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: T.surface,
  },
  badgeIcon: { fontSize: 16 },
  badgeName: { fontSize: 13, fontWeight: '600' },

  title: { fontSize: 26, fontWeight: '800', color: T.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: T.text2, lineHeight: 21 },

  securityCard: {
    backgroundColor: T.surface, borderRadius: 14,
    borderWidth: 1, borderColor: T.border,
    padding: 16, gap: 6,
  },
  securityTitle: { fontSize: 14, fontWeight: '600', color: T.text },
  securityText: { fontSize: 13, color: T.text2, lineHeight: 20 },

  inputGroup: { gap: 8 },
  inputWrap: {
    backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: 12,
  },
  inputWrapError: { borderColor: T.red },
  input: {
    paddingHorizontal: 16, paddingVertical: 14,
    color: T.text, fontSize: 15, fontFamily: 'monospace',
  },
  errorText: { color: T.red, fontSize: 13 },
  hint: { fontSize: 13, color: T.text3, lineHeight: 18 },

  footer: { paddingHorizontal: 24, paddingBottom: 12, gap: 8 },
  btn: { borderRadius: 14, paddingVertical: 17, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  skipBtn: { paddingVertical: 12, alignItems: 'center' },
  skipText: { color: T.text2, fontSize: 15 },
});
