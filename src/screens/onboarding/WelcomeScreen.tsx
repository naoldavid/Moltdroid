import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const T = {
  bg: '#000000', surface: '#111111', border: '#2C2C2E',
  red: '#E8202A', text: '#FFFFFF', text2: '#8E8E93', text3: '#48484A',
};

interface Props { onNext: () => void }

const FEATURES = [
  { icon: '⚡', text: 'Runs 24/7 as a background service' },
  { icon: '💬', text: 'Chat via Telegram from anywhere' },
  { icon: '🧠', text: 'Claude, GPT-4, Gemini — your choice' },
  { icon: '🔧', text: 'Installs skills from ClawHub' },
  { icon: '📁', text: 'Creates files, runs Python & JS code' },
];

export default function WelcomeScreen({ onNext }: Props) {
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 400,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View style={[{ flex: 1 }, { opacity: fadeAnim }]}>
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        {/* Lobster animation */}
        <View style={styles.logoWrap}>
          <Image
            source={require('../../assets/Lobster.gif')}
            style={styles.video}
          />
          <Text style={styles.logoName}>MoltDroid</Text>
          <Text style={styles.logoTagline}>Autonomous AI agent for Android</Text>
        </View>

        {/* Features */}
        <View style={styles.featureCard}>
          {FEATURES.map(({ icon, text }, i) => (
            <View key={i} style={[styles.featureRow, i < FEATURES.length - 1 && styles.featureDivider]}>
              <Text style={styles.featureIcon}>{icon}</Text>
              <Text style={styles.featureText}>{text}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.btn} onPress={onNext} activeOpacity={0.85}>
          <Text style={styles.btnText}>Get Started</Text>
        </TouchableOpacity>
        <Text style={styles.footerNote}>No account required · Runs entirely on-device</Text>
        <Text style={styles.footerBy}>Made by Naol Haase</Text>
      </View>
    </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg, justifyContent: 'space-between' },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 36 },

  logoWrap: { alignItems: 'center', gap: 12 },
  video: { width: 200, height: 200, borderRadius: 24, overflow: 'hidden' },
  logoName: { fontSize: 32, fontWeight: '800', color: T.text, letterSpacing: -0.5 },
  logoTagline: { fontSize: 15, color: T.text2 },

  featureCard: {
    backgroundColor: T.surface, borderRadius: 16,
    borderWidth: 1, borderColor: T.border,
    overflow: 'hidden',
  },
  featureRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14, paddingHorizontal: 18,
  },
  featureDivider: { borderBottomWidth: 1, borderBottomColor: T.border },
  featureIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  featureText: { fontSize: 15, color: T.text, flex: 1 },

  footer: { paddingHorizontal: 24, paddingBottom: 12, gap: 10 },
  btn: {
    backgroundColor: T.red, borderRadius: 14,
    paddingVertical: 17, alignItems: 'center',
  },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  footerNote: { color: T.text3, fontSize: 12, textAlign: 'center' },
  footerBy: { color: T.text3, fontSize: 11, textAlign: 'center', opacity: 0.6 },
});
