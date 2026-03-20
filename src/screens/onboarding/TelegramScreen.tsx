import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, KeyboardAvoidingView, Platform, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettings } from '../../context/SettingsContext';

const T = {
  bg: '#000000', surface: '#111111', border: '#2C2C2E',
  red: '#E8202A', blue: '#0A84FF', text: '#FFFFFF', text2: '#8E8E93', text3: '#48484A',
};

interface Props { onNext: () => void; onBack: () => void }

const STEPS = [
  'Open @BotFather in Telegram',
  'Send /newbot and follow the prompts',
  'Copy the token and paste it below',
  'Start the agent — it will detect your chat automatically',
];

export default function TelegramScreen({ onNext, onBack }: Props) {
  const { saveBotToken } = useSettings();
  const [botToken, setBotToken] = useState('');
  const [error, setError] = useState('');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);

  const handleNext = async () => {
    if (botToken.trim().length < 10) {
      setError('Enter a valid bot token (e.g. 123456789:AAF...)');
      return;
    }
    await saveBotToken(botToken.trim());
    onNext();
  };

  const handleSkip = () => onNext();

  return (
    <Animated.View style={[{ flex: 1 }, { opacity: fadeAnim }]}>
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.stepText}>3 / 4</Text>
        </View>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>Connect Telegram</Text>
          <Text style={styles.subtitle}>
            Add a Telegram bot so you can chat with your agent from anywhere.
          </Text>

          {/* Steps */}
          <View style={styles.stepsCard}>
            {STEPS.map((step, i) => (
              <View key={i} style={[styles.stepRow, i < STEPS.length - 1 && styles.stepDivider]}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{i + 1}</Text>
                </View>
                <Text style={styles.stepText2}>{step}</Text>
              </View>
            ))}
          </View>

          {/* Input */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Bot Token</Text>
            <View style={[styles.inputWrap, !!error && styles.inputError]}>
              <TextInput
                style={styles.input}
                value={botToken}
                onChangeText={(t) => { setBotToken(t); setError(''); }}
                placeholder="123456789:AAF_example_token"
                placeholderTextColor={T.text3}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
            </View>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <Text style={styles.hint}>
              🔒 Stored write-only in Android Keystore · Never displayed after saving
            </Text>
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.btnSkip} onPress={handleSkip} activeOpacity={0.8}>
              <Text style={styles.btnSkipText}>Skip</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnNext} onPress={handleNext} activeOpacity={0.85}>
              <Text style={styles.btnText}>Continue</Text>
            </TouchableOpacity>
          </View>
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

  body: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16, gap: 24 },
  title: { fontSize: 28, fontWeight: '800', color: T.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 15, color: T.text2, lineHeight: 22 },

  stepsCard: {
    backgroundColor: T.surface, borderRadius: 14,
    borderWidth: 1, borderColor: T.border, overflow: 'hidden',
  },
  stepRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 13, paddingHorizontal: 16,
  },
  stepDivider: { borderBottomWidth: 1, borderBottomColor: T.border },
  stepNum: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(10,132,255,0.15)', alignItems: 'center', justifyContent: 'center',
  },
  stepNumText: { color: T.blue, fontSize: 13, fontWeight: '700' },
  stepText2: { color: T.text, fontSize: 14, flex: 1, lineHeight: 20 },

  inputGroup: { gap: 8 },
  inputLabel: { color: T.text2, fontSize: 13, fontWeight: '600' },
  inputWrap: {
    backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: 12,
  },
  inputError: { borderColor: T.red },
  input: {
    paddingHorizontal: 16, paddingVertical: 14,
    color: T.text, fontSize: 15, fontFamily: 'monospace',
  },
  errorText: { color: T.red, fontSize: 13 },
  hint: { color: T.text3, fontSize: 12, lineHeight: 18 },

  footer: { paddingHorizontal: 24, paddingBottom: 12 },
  btnRow: { flexDirection: 'row', gap: 12 },
  btnSkip: {
    flex: 1, borderWidth: 1, borderColor: T.border,
    paddingVertical: 17, borderRadius: 14, alignItems: 'center',
  },
  btnSkipText: { color: T.text2, fontWeight: '600', fontSize: 16 },
  btnNext: {
    flex: 2, backgroundColor: T.red,
    paddingVertical: 17, borderRadius: 14, alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 17 },
});
