import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const T = {
  bg:      '#000000',
  surface: '#111111',
  border:  '#2C2C2E',
  red:     '#E8202A',
  redDim:  'rgba(232,32,42,0.10)',
  text:    '#FFFFFF',
  text2:   '#8E8E93',
  text3:   '#48484A',
};

interface Props {
  onAccept: () => void;
}

export default function TermsScreen({ onAccept }: Props) {
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const isBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 40;
    if (isBottom) setScrolledToEnd(true);
  };

  return (
    <Animated.View style={[{ flex: 1 }, { opacity: fadeAnim }]}>
    <SafeAreaView style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.hexSymbol}>⬡</Text>
        <View>
          <Text style={styles.title}>Terms & Conditions</Text>
          <Text style={styles.subtitle}>Read before continuing</Text>
        </View>
      </View>

      {/* Scrollable T&C */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        showsVerticalScrollIndicator>

        <Section title="⚠️ AI Agent Risks">
          {`MoltDroid runs an autonomous AI agent on your device. The agent can take actions including creating and modifying files, running code, making web requests, and sending Telegram messages on your behalf.\n\nAI agents can make mistakes, misunderstand instructions, or produce unexpected results. Always supervise agent activity, especially for important tasks.`}
        </Section>

        <Section title="🔑 API Keys & Credentials">
          {`Your API keys (for Anthropic, OpenAI, Google, etc.) and Telegram bot tokens are stored encrypted on your device using Android's hardware-backed Keystore system.\n\nHowever, your API keys are transmitted to the respective AI provider's servers when the agent makes requests. By using MoltDroid you agree to each provider's terms of service.\n\nNever share your API keys. MoltDroid does not send your keys to any server other than the AI provider you have configured.`}
        </Section>

        <Section title="💻 Code Execution">
          {`The agent can execute JavaScript and Python code directly on your device in response to your messages or installed skills. This code runs in a sandboxed Node.js and Python environment, but has access to:\n\n• The agent's data folder on your device\n• The internet (via fetch/requests)\n• Your Telegram bot (to send messages)\n\nOnly install skills from sources you trust. MoltDroid is not responsible for actions taken by third-party skills.`}
        </Section>

        <Section title="📦 ClawHub Skills">
          {`Skills installed from ClawHub or other sources are third-party software. Each skill can define custom behaviour and instructions for the AI agent.\n\nMoltDroid does not review or endorse third-party skills. You are responsible for reviewing any skill before installing it. A malicious skill could instruct the agent to perform harmful actions.`}
        </Section>

        <Section title="🔒 Data & Privacy">
          {`MoltDroid does not collect any data. All settings and files remain on your device.\n\nYour conversation history is stored locally and sent to the AI provider you configured for inference. Refer to your AI provider's privacy policy for how they handle your data.\n\nTelegram messages are processed through Telegram's servers per their privacy policy.`}
        </Section>

        <Section title="⚖️ Disclaimer & Liability">
          {`MoltDroid is provided "as is" without warranty of any kind. The developers are not liable for:\n\n• Actions taken by the AI agent\n• Data loss or corruption\n• Costs incurred from API usage\n• Any damages arising from use of this app\n\nYou use MoltDroid entirely at your own risk. You are responsible for all actions the agent takes on your behalf.`}
        </Section>

        <Section title="✅ Your Agreement">
          {`By tapping "I Accept & Continue" you confirm that:\n\n• You have read and understood these terms\n• You are at least 13 years old\n• You accept full responsibility for the agent's actions\n• You will comply with all applicable AI provider terms of service`}
        </Section>

        {!scrolledToEnd && (
          <View style={styles.scrollHint}>
            <Text style={styles.scrollHintText}>↓ Scroll to read all terms</Text>
          </View>
        )}
      </ScrollView>

      {/* Accept Button */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.btn, !scrolledToEnd && styles.btnDisabled]}
          onPress={scrolledToEnd ? onAccept : undefined}
          activeOpacity={0.8}>
          <Text style={[styles.btnText, !scrolledToEnd && styles.btnTextDisabled]}>
            I Accept & Continue
          </Text>
        </TouchableOpacity>
        <Text style={styles.footerHint}>
          {scrolledToEnd ? 'Tap to agree and proceed' : 'Read all terms to continue'}
        </Text>
      </View>
    </SafeAreaView>
    </Animated.View>
  );
}

function Section({ title, children }: { title: string; children: string }) {
  return (
    <View style={sStyles.root}>
      <Text style={sStyles.title}>{title}</Text>
      <Text style={sStyles.body}>{children}</Text>
    </View>
  );
}

const sStyles = StyleSheet.create({
  root: { marginBottom: 24 },
  title: { fontSize: 15, fontWeight: '700', color: T.text, marginBottom: 10 },
  body: { fontSize: 14, color: T.text2, lineHeight: 22 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 24, paddingTop: 16, paddingBottom: 20,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  hexSymbol: { fontSize: 36, color: T.red },
  title: { fontSize: 20, fontWeight: '700', color: T.text },
  subtitle: { fontSize: 13, color: T.text2, marginTop: 2 },

  scroll: { flex: 1 },
  scrollContent: { padding: 24, paddingBottom: 8 },

  scrollHint: {
    alignItems: 'center', paddingVertical: 16,
    borderTopWidth: 1, borderTopColor: T.border,
    marginTop: 8,
  },
  scrollHintText: { color: T.text3, fontSize: 13 },

  footer: {
    paddingHorizontal: 24, paddingTop: 16, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: T.border,
    gap: 8,
  },
  btn: {
    backgroundColor: T.red, borderRadius: 14,
    paddingVertical: 16, alignItems: 'center',
  },
  btnDisabled: { backgroundColor: T.text3 },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  btnTextDisabled: { color: '#888' },
  footerHint: { color: T.text3, fontSize: 12, textAlign: 'center' },
});
