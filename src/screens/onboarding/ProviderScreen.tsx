import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AI_PROVIDERS, type AIProvider, useSettings } from '../../context/SettingsContext';

const T = {
  bg: '#000000', surface: '#111111', surface2: '#1C1C1E', border: '#2C2C2E',
  red: '#E8202A', text: '#FFFFFF', text2: '#8E8E93', text3: '#48484A',
};

interface Props { onNext: () => void; onBack: () => void }

const PROVIDER_ORDER: AIProvider[] = ['google', 'anthropic', 'openai'];

export default function ProviderScreen({ onNext, onBack }: Props) {
  const { settings, save } = useSettings();
  const [provider, setProvider] = useState<AIProvider>(settings.ai.provider);
  const [model, setModel] = useState(settings.ai.model);
  const cfg = AI_PROVIDERS[provider];
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);

  const handleProviderSelect = (p: AIProvider) => {
    setProvider(p);
    setModel(AI_PROVIDERS[p].models[0].id);
  };

  const handleNext = async () => {
    await save({ ai: { ...settings.ai, provider, model } });
    onNext();
  };

  return (
    <Animated.View style={[{ flex: 1 }, { opacity: fadeAnim }]}>
    <SafeAreaView style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.stepText}>1 / 4</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Choose your AI</Text>
        <Text style={styles.subtitle}>Select the AI provider that powers your agent. You can change this later.</Text>

        {/* Provider Cards */}
        <View style={styles.providerGrid}>
          {PROVIDER_ORDER.map((p) => {
            const pc = AI_PROVIDERS[p];
            const active = p === provider;
            return (
              <TouchableOpacity
                key={p}
                style={[styles.providerCard, active && { borderColor: pc.color, backgroundColor: T.surface2 }]}
                onPress={() => handleProviderSelect(p)}
                activeOpacity={0.75}>
                <Text style={styles.providerIcon}>{pc.icon}</Text>
                <Text style={[styles.providerName, active && { color: pc.color }]}>
                  {p === 'anthropic' ? 'Claude' : p === 'openai' ? 'OpenAI' : 'Gemini'}
                </Text>
                {active && <View style={[styles.activeBadge, { backgroundColor: pc.color }]} />}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Model Picker */}
        <Text style={styles.sectionLabel}>SELECT MODEL</Text>
        <View style={styles.modelList}>
          {cfg.models.map((m, i) => {
            const active = m.id === model;
            return (
              <TouchableOpacity
                key={m.id}
                style={[
                  styles.modelRow,
                  active && { borderColor: cfg.color },
                  i < cfg.models.length - 1 && styles.modelRowBorder,
                ]}
                onPress={() => setModel(m.id)}
                activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.modelName, active && { color: cfg.color }]}>{m.name}</Text>
                  <Text style={styles.modelDesc}>{m.desc}</Text>
                </View>
                <View style={[styles.radio, active && { borderColor: cfg.color }]}>
                  {active && <View style={[styles.radioDot, { backgroundColor: cfg.color }]} />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={[styles.btn, { backgroundColor: cfg.color }]} onPress={handleNext} activeOpacity={0.85}>
          <Text style={styles.btnText}>Continue</Text>
        </TouchableOpacity>
      </View>
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

  body: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
  title: { fontSize: 28, fontWeight: '800', color: T.text, marginBottom: 8, letterSpacing: -0.5 },
  subtitle: { fontSize: 15, color: T.text2, lineHeight: 22, marginBottom: 28 },

  providerGrid: { flexDirection: 'row', gap: 10, marginBottom: 28 },
  providerCard: {
    flex: 1, backgroundColor: T.surface, borderRadius: 14,
    borderWidth: 1.5, borderColor: T.border,
    paddingVertical: 18, alignItems: 'center', gap: 8, position: 'relative',
  },
  providerIcon: { fontSize: 28 },
  providerName: { color: T.text2, fontSize: 13, fontWeight: '600' },
  activeBadge: {
    position: 'absolute', top: 8, right: 8,
    width: 8, height: 8, borderRadius: 4,
  },

  sectionLabel: {
    color: T.text3, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    marginBottom: 10,
  },

  modelList: {
    backgroundColor: T.surface, borderRadius: 14,
    borderWidth: 1, borderColor: T.border,
    overflow: 'hidden',
  },
  modelRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 16, gap: 12,
    borderWidth: 0, borderColor: 'transparent',
  },
  modelRowBorder: { borderBottomWidth: 1, borderBottomColor: T.border },
  modelName: { color: T.text, fontSize: 15, fontWeight: '500' },
  modelDesc: { color: T.text2, fontSize: 12, marginTop: 2 },
  radio: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: T.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },

  footer: { paddingHorizontal: 24, paddingBottom: 12 },
  btn: { borderRadius: 14, paddingVertical: 17, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
