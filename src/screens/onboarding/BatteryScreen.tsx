import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OpenClawModule } from '../../native/OpenClawModule';

const T = {
  bg: '#000000', surface: '#111111', border: '#2C2C2E',
  red: '#E8202A', green: '#30D158', amber: '#FF9F0A',
  text: '#FFFFFF', text2: '#8E8E93', text3: '#48484A',
};

interface Props { onNext: () => void; onBack: () => void }

export default function BatteryScreen({ onNext, onBack }: Props) {
  const [ignored, setIgnored] = useState<boolean | null>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const check = async () => {
    const ok = await OpenClawModule.isIgnoringBatteryOptimizations();
    setIgnored(ok);
  };

  useEffect(() => {
    check();
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);

  const handleWhitelist = () => {
    OpenClawModule.requestBatteryOptimizationWhitelist();
    setTimeout(check, 1500);
  };

  return (
    <Animated.View style={[{ flex: 1 }, { opacity: fadeAnim }]}>
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.stepText}>4 / 4</Text>
      </View>

      <View style={styles.body}>
        {/* Status icon */}
        <View style={[styles.iconWrap, { backgroundColor: ignored ? 'rgba(48,209,88,0.12)' : 'rgba(255,159,10,0.12)' }]}>
          <Text style={styles.iconText}>{ignored ? '✓' : '🔋'}</Text>
        </View>

        <Text style={styles.title}>Battery Optimization</Text>
        <Text style={styles.subtitle}>
          Android can kill background apps to save battery. Whitelist MoltDroid so the agent keeps running when the screen is off.
        </Text>

        {/* Status card */}
        <View style={[styles.statusCard, ignored ? styles.statusOk : styles.statusWarn]}>
          <Text style={[styles.statusText, { color: ignored ? T.green : T.amber }]}>
            {ignored === null
              ? 'Checking status...'
              : ignored
              ? '✓ MoltDroid is whitelisted — agent will run reliably'
              : '⚠ Battery optimization is active — may kill the agent'}
          </Text>
        </View>

        {ignored === false && (
          <TouchableOpacity style={styles.whitelistBtn} onPress={handleWhitelist} activeOpacity={0.85}>
            <Text style={styles.whitelistText}>Request Whitelist Permission</Text>
          </TouchableOpacity>
        )}

        <View style={styles.infoCard}>
          <Text style={styles.infoText}>
            Without whitelisting, Android may terminate the foreground service and Node.js runtime after the screen turns off for an extended period.
          </Text>
        </View>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity style={[styles.btn, !ignored && styles.btnOutline]} onPress={onNext} activeOpacity={0.85}>
          <Text style={[styles.btnText, !ignored && styles.btnTextOutline]}>
            {ignored ? "Let's Go →" : 'Skip for now'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg, justifyContent: 'space-between' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 24, paddingVertical: 14,
  },
  backText: { color: T.text2, fontSize: 15 },
  stepText: { color: T.text3, fontSize: 13 },

  body: { flex: 1, paddingHorizontal: 24, justifyContent: 'center', gap: 20 },

  iconWrap: {
    width: 80, height: 80, borderRadius: 24,
    alignSelf: 'center', alignItems: 'center', justifyContent: 'center',
  },
  iconText: { fontSize: 40 },
  title: { fontSize: 26, fontWeight: '800', color: T.text, textAlign: 'center', letterSpacing: -0.5 },
  subtitle: { fontSize: 15, color: T.text2, lineHeight: 22, textAlign: 'center' },

  statusCard: {
    borderRadius: 14, padding: 16,
    borderWidth: 1,
  },
  statusOk: { backgroundColor: 'rgba(48,209,88,0.08)', borderColor: 'rgba(48,209,88,0.3)' },
  statusWarn: { backgroundColor: 'rgba(255,159,10,0.08)', borderColor: 'rgba(255,159,10,0.3)' },
  statusText: { fontSize: 14, lineHeight: 21, fontWeight: '500' },

  whitelistBtn: {
    backgroundColor: T.amber, borderRadius: 14,
    paddingVertical: 15, alignItems: 'center',
  },
  whitelistText: { color: '#000', fontWeight: '700', fontSize: 16 },

  infoCard: {
    backgroundColor: T.surface, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: T.border,
  },
  infoText: { color: T.text2, fontSize: 13, lineHeight: 20 },

  footer: { paddingHorizontal: 24, paddingBottom: 12 },
  btn: { backgroundColor: T.red, borderRadius: 14, paddingVertical: 17, alignItems: 'center' },
  btnOutline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: T.border },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  btnTextOutline: { color: T.text2 },
});
