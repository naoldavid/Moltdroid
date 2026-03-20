import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, KeyboardAvoidingView, Linking, Modal, Platform, PermissionsAndroid,
  RefreshControl, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import nodejs from 'nodejs-mobile-react-native';
import { OpenClawModule } from '../native/OpenClawModule';
import { useOpenClaw, type GatewayStatus } from '../hooks/useOpenClaw';
import { AI_PROVIDERS, useSettings } from '../context/SettingsContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileItem { name: string; type: 'file' | 'dir' }
interface AgentEvent {
  id: string; ts: string;
  kind: 'telegram' | 'ai' | 'system' | 'error' | 'skill' | 'file';
  text: string;
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const T = {
  bg:       '#000000',
  surface:  '#111111',
  surface2: '#1C1C1E',
  border:   '#2C2C2E',
  red:      '#E8202A',
  redDim:   'rgba(232,32,42,0.10)',
  green:    '#30D158',
  amber:    '#FF9F0A',
  blue:     '#0A84FF',
  purple:   '#BF5AF2',
  text:     '#FFFFFF',
  text2:    '#8E8E93',
  text3:    '#48484A',
};

const STATUS_COLOR: Record<GatewayStatus, string> = {
  idle: T.text3, starting: T.amber, running: T.green, error: T.red, stopped: T.text3,
};
const STATUS_LABEL: Record<GatewayStatus, string> = {
  idle: 'Offline', starting: 'Starting…', running: 'Online', error: 'Error', stopped: 'Offline',
};
const STATUS_BG: Record<GatewayStatus, string> = {
  idle: T.surface, starting: 'rgba(255,159,10,0.08)', running: 'rgba(48,209,88,0.08)', error: 'rgba(232,32,42,0.08)', stopped: T.surface,
};

const EVENT_COLOR: Record<AgentEvent['kind'], string> = {
  telegram: T.blue, ai: T.purple, system: T.text3, error: T.red, skill: T.amber, file: T.green,
};
const EVENT_LABEL: Record<AgentEvent['kind'], string> = {
  telegram: 'TG', ai: 'AI', system: 'SYS', error: 'ERR', skill: 'SKL', file: 'FILE',
};

let _eid = 0;
function makeEventId() { return String(++_eid); }
function fmtTime() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}
function parseLog(line: string): AgentEvent | null {
  const text = line.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.Z]+\] /, '').trim();
  if (!text) return null;
  let kind: AgentEvent['kind'] = 'system';
  if (/telegram|Telegram/i.test(text))    kind = 'telegram';
  else if (/🧠|AI|claude|gpt|gemini|Reply/i.test(text)) kind = 'ai';
  else if (/skill|Skill/i.test(text))     kind = 'skill';
  else if (/[Ff]ile/i.test(text))         kind = 'file';
  else if (/error|Error|ERROR|failed/i.test(text)) kind = 'error';
  return { id: makeEventId(), ts: fmtTime(), kind, text };
}
function requestId() { return Math.random().toString(36).slice(2); }

// ── Pulse dot for running status ──────────────────────────────────────────────

function PulseDot({ active, color }: { active: boolean; color: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) { anim.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: 800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      Animated.timing(anim, { toValue: 0, duration: 800, easing: Easing.in(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [active]);
  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.3] });
  const opacity = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.5, 1] });
  return (
    <Animated.View style={[styles.pulseDot, { backgroundColor: color, transform: [{ scale }], opacity }]} />
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function HomeScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { settings, save } = useSettings();
  const { status, logs, start, stop } = useOpenClaw();
  const [batteryOk, setBatteryOk]   = useState<boolean | null>(null);
  const [telegramOk, setTelegramOk] = useState(false);
  const [filesDir, setFilesDir]     = useState('');
  const [events, setEvents]         = useState<AgentEvent[]>([]);
  const [files, setFiles]           = useState<{ data: FileItem[]; skills: FileItem[] }>({ data: [], skills: [] });
  const [tab, setTab]               = useState<'activity' | 'files'>('activity');
  const [refreshing, setRefreshing] = useState(false);
  const [canvas, setCanvas]         = useState<{ html?: string; url?: string } | null>(null);
  const [fileView, setFileView]     = useState<{ name: string; content: string } | null>(null);
  const [pairingCode, setPairingCode]   = useState<string | null>(null);
  const [pairingInput, setPairingInput] = useState('');
  const [pairingError, setPairingError] = useState('');

  const settingsRef  = useRef(settings);
  const loadFilesRef = useRef<() => void>(() => {});
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const isRunning = status === 'running' || status === 'starting';
  const statusColor = STATUS_COLOR[status];

  // ── Permissions & init ───────────────────────────────────────────────────

  useEffect(() => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }
    OpenClawModule.isIgnoringBatteryOptimizations().then(setBatteryOk);
    OpenClawModule.getFilesDir().then(setFilesDir);
  }, []);

  // ── IPC from Node.js ─────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (msg: string) => {
      try {
        const parsed = JSON.parse(msg);
        const { type, payload } = parsed;
        if (type === 'saveChatId' && payload?.chatId) {
          save({ telegram: { chatId: payload.chatId } });
        } else if (type === 'filesChanged') {
          loadFilesRef.current();
        } else if (type === 'telegram') {
          setTelegramOk(payload === 'connected');
        } else if (type === 'canvas') {
          setCanvas(payload?.clear ? null : { html: payload?.html, url: payload?.url });
        } else if (type === 'device' && payload?.command === 'notify') {
          OpenClawModule.showNotification(payload.title ?? 'MoltDroid', payload.body ?? '');
        } else if (type === 'pairingCode') {
          setPairingCode(payload?.code ?? '');
          setPairingInput('');
          setPairingError('');
        } else if (type === 'pairResult') {
          if (payload?.success) {
            setPairingCode(null);
            setPairingInput('');
            setPairingError('');
          } else {
            const msg = payload?.error === 'Code expired'
              ? 'Code abgelaufen — schreib deinem Bot erneut'
              : 'Falscher Code, nochmal versuchen';
            setPairingError(msg);
          }
        }
      } catch {}
    };
    const sub: any = nodejs.channel.addListener('message', handler);
    return () => { if (sub?.remove) sub.remove(); };
  }, []);

  // ── Logs → Events ────────────────────────────────────────────────────────

  useEffect(() => {
    if (logs.length === 0) return;
    const ev = parseLog(logs[0]);
    if (ev) setEvents((prev) => [ev, ...prev].slice(0, 100));
  }, [logs]);

  // ── File listing ──────────────────────────────────────────────────────────

  const loadFiles = useCallback(() => {
    if (!isRunning) return;
    const rid = requestId();
    let sub1: any = null;
    const h1 = (msg: string) => {
      try {
        const { type, payload, requestId: id } = JSON.parse(msg);
        if (type === 'result' && id === rid) {
          if (sub1?.remove) sub1.remove();
          setFiles((prev) => ({ ...prev, data: (payload.files || []).map((f: string) => ({ name: f, type: 'file' })) }));
          setRefreshing(false);
        }
      } catch {}
    };
    sub1 = nodejs.channel.addListener('message', h1);
    nodejs.channel.send(JSON.stringify({ type: 'listFiles', payload: { subdir: 'data' }, requestId: rid }));

    const rid2 = requestId();
    let sub2: any = null;
    const h2 = (msg: string) => {
      try {
        const { type, payload, requestId: id } = JSON.parse(msg);
        if (type === 'result' && id === rid2) {
          if (sub2?.remove) sub2.remove();
          setFiles((prev) => ({ ...prev, skills: (payload.files || []).map((f: string) => ({ name: f, type: 'file' })) }));
        }
      } catch {}
    };
    sub2 = nodejs.channel.addListener('message', h2);
    nodejs.channel.send(JSON.stringify({ type: 'listFiles', payload: { subdir: 'skills' }, requestId: rid2 }));
  }, [isRunning]);

  useEffect(() => { loadFilesRef.current = loadFiles; }, [loadFiles]);

  const openFile = useCallback((subdir: 'data' | 'skills', name: string) => {
    const rid = requestId();
    const handler = (msg: string) => {
      try {
        const { type, payload, requestId: id } = JSON.parse(msg);
        if (type === 'result' && id === rid) {
          setFileView({ name: `${subdir}/${name}`, content: payload.content ?? '(empty)' });
        }
      } catch {}
    };
    const sub: any = nodejs.channel.addListener('message', handler);
    setTimeout(() => { if (sub?.remove) sub.remove(); }, 5000);
    nodejs.channel.send(JSON.stringify({ type: 'readFile', payload: { name, subdir }, requestId: rid }));
  }, []);

  useEffect(() => { if (tab === 'files') loadFiles(); }, [tab, isRunning]);

  // ── Derived AI label ──────────────────────────────────────────────────────

  const ai = settings.ai ?? { provider: 'google' as const, model: '', hasApiKey: false };
  const aiPc = AI_PROVIDERS[ai.provider];
  const aiModelLabel = aiPc?.models?.find((m) => m.id === ai.model)?.name ?? ai.model ?? 'No model';
  const hasKey = ai.hasApiKey;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.root}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.headerBrand}>
          <Text style={styles.headerHex}>⬡</Text>
          <View>
            <Text style={styles.headerTitle}>MoltDroid</Text>
            <Text style={styles.headerSub}>by Naol Haase</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.settingsBtn} onPress={onOpenSettings} activeOpacity={0.7}>
          <Text style={styles.settingsBtnText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* ── Status Card ── */}
      <View style={[styles.statusCard, { backgroundColor: STATUS_BG[status] }]}>
        <View style={styles.statusLeft}>
          <View style={styles.statusIndicator}>
            <PulseDot active={status === 'running'} color={statusColor} />
            <Text style={[styles.statusLabel, { color: statusColor }]}>{STATUS_LABEL[status]}</Text>
          </View>
          <View style={styles.statusTags}>
            {/* Telegram */}
            <View style={[styles.tag, telegramOk && styles.tagGreen]}>
              <Text style={[styles.tagText, { color: telegramOk ? T.green : T.text3 }]}>
                {!settings.telegram.hasToken ? 'No Telegram' : telegramOk ? 'Telegram ✓' : 'Telegram ✗'}
              </Text>
            </View>
            {/* AI model */}
            <View style={[styles.tag, !hasKey && styles.tagWarn]}>
              <Text style={[styles.tagText, { color: hasKey ? (aiPc?.color ?? T.text2) : T.amber }]}>
                {hasKey ? aiModelLabel : `${aiModelLabel} (no key)`}
              </Text>
            </View>
            {/* Web UI */}
            {isRunning && (
              <TouchableOpacity style={[styles.tag, styles.tagBlue]} onPress={() => Linking.openURL('http://localhost:18789/ui')}>
                <Text style={[styles.tagText, { color: T.blue }]}>Web UI ↗</Text>
              </TouchableOpacity>
            )}
            {/* Battery */}
            {batteryOk === false && (
              <TouchableOpacity style={[styles.tag, styles.tagWarn]} onPress={() => OpenClawModule.requestBatteryOptimizationWhitelist()}>
                <Text style={[styles.tagText, { color: T.amber }]}>Battery Opt — Fix</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      {/* ── Controls ── */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.btnStart, isRunning && styles.btnDisabled]}
          onPress={() => start(settings)}
          disabled={isRunning}
          activeOpacity={0.85}>
          {status === 'starting'
            ? <ActivityIndicator color={T.red} size="small" />
            : <Text style={styles.btnStartText}>Start Agent</Text>
          }
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btnStop, !isRunning && styles.btnDisabled]}
          onPress={stop}
          disabled={!isRunning}
          activeOpacity={0.85}>
          <Text style={[styles.btnStopText, !isRunning && { opacity: 0.3 }]}>Stop</Text>
        </TouchableOpacity>
      </View>

      {/* ── Tab Bar ── */}
      <View style={styles.tabBar}>
        {(['activity', 'files'] as const).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tabItem, tab === t && styles.tabItemActive]}
            onPress={() => setTab(t)}
            activeOpacity={0.7}>
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>
              {t === 'activity' ? 'Activity' : `Files${isRunning ? `  ${files.data.length + files.skills.length}` : ''}`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Activity Feed ── */}
      {tab === 'activity' && (
        <ScrollView style={styles.feedWrap} contentContainerStyle={styles.feedContent}>
          {events.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyHex}>⬡</Text>
              <Text style={styles.emptyTitle}>No activity yet</Text>
              <Text style={styles.emptySubtitle}>Start the agent and send a message to your Telegram bot</Text>
            </View>
          ) : events.map((ev) => (
            <View key={ev.id} style={styles.eventRow}>
              <View style={[styles.eventBadge, { backgroundColor: `${EVENT_COLOR[ev.kind]}1A` }]}>
                <Text style={[styles.eventBadgeText, { color: EVENT_COLOR[ev.kind] }]}>
                  {EVENT_LABEL[ev.kind]}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.eventText, { color: EVENT_COLOR[ev.kind] }]} numberOfLines={2}>
                  {ev.text}
                </Text>
              </View>
              <Text style={styles.eventTs}>{ev.ts}</Text>
            </View>
          ))}
        </ScrollView>
      )}

      {/* ── Files Tab ── */}
      {tab === 'files' && (
        <ScrollView
          style={styles.feedWrap}
          contentContainerStyle={styles.feedContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadFiles(); }} tintColor={T.red} />
          }>
          <Text style={styles.fileSection}>Data Files</Text>
          {files.data.length === 0
            ? <Text style={styles.filePlaceholder}>No files yet</Text>
            : (
              <View style={styles.fileCard}>
                {files.data.map((f, i) => (
                  <TouchableOpacity
                    key={f.name}
                    style={[styles.fileRow, i < files.data.length - 1 && styles.fileRowDivider]}
                    onPress={() => openFile('data', f.name)}
                    activeOpacity={0.7}>
                    <Text style={styles.fileIcon}>📄</Text>
                    <Text style={styles.fileName}>{f.name}</Text>
                    <Text style={styles.fileChevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

          <Text style={[styles.fileSection, { marginTop: 24 }]}>Skills</Text>
          {files.skills.length === 0
            ? <Text style={styles.filePlaceholder}>No skills — send /skill install {'<slug>'} to the agent</Text>
            : (
              <View style={styles.fileCard}>
                {files.skills.map((f, i) => (
                  <TouchableOpacity
                    key={f.name}
                    style={[styles.fileRow, i < files.skills.length - 1 && styles.fileRowDivider]}
                    onPress={() => openFile('skills', f.name)}
                    activeOpacity={0.7}>
                    <Text style={styles.fileIcon}>⬡</Text>
                    <Text style={styles.fileName}>{f.name}</Text>
                    <Text style={styles.fileChevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          {filesDir ? <Text style={styles.pathHint}>{filesDir}</Text> : null}
        </ScrollView>
      )}

      {/* ── File Viewer Modal ── */}
      {fileView && (
        <Modal visible animationType="slide" onRequestClose={() => setFileView(null)}>
          <SafeAreaView style={styles.modalRoot}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle} numberOfLines={1}>{fileView.name}</Text>
              <TouchableOpacity onPress={() => setFileView(null)} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
              <Text style={styles.fileViewContent}>{fileView.content}</Text>
            </ScrollView>
          </SafeAreaView>
        </Modal>
      )}

      {/* ── Pairing Modal ── */}
      {pairingCode !== null && (
        <Modal visible animationType="fade" transparent onRequestClose={() => {}}>
          <KeyboardAvoidingView
            style={styles.pairOverlay}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={styles.pairCard}>
              <Text style={styles.pairIcon}>🔐</Text>
              <Text style={styles.pairTitle}>Telegram pairen</Text>
              <Text style={styles.pairSubtitle}>
                Jemand hat deinem Bot eine Nachricht geschickt.{'\n'}
                Gib den Code aus Telegram ein, um die Verbindung zu bestätigen.
              </Text>
              <TextInput
                style={styles.pairInput}
                value={pairingInput}
                onChangeText={t => { setPairingInput(t.replace(/\D/g, '').slice(0, 6)); setPairingError(''); }}
                placeholder="000000"
                placeholderTextColor={T.text3}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
              />
              {pairingError ? <Text style={styles.pairError}>{pairingError}</Text> : null}
              <View style={styles.pairButtons}>
                <TouchableOpacity
                  style={[styles.pairBtn, styles.pairBtnIgnore]}
                  onPress={() => { setPairingCode(null); setPairingInput(''); setPairingError(''); }}
                  activeOpacity={0.7}>
                  <Text style={styles.pairBtnIgnoreText}>Ignorieren</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.pairBtn, styles.pairBtnConfirm, pairingInput.length < 6 && styles.btnDisabled]}
                  onPress={() => {
                    if (pairingInput.length < 6) return;
                    nodejs.channel.send(JSON.stringify({ type: 'pairConfirm', payload: { code: pairingInput } }));
                  }}
                  disabled={pairingInput.length < 6}
                  activeOpacity={0.85}>
                  <Text style={styles.pairBtnConfirmText}>Verifizieren</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}

      {/* ── Canvas WebView ── */}
      {canvas && (
        <Modal visible animationType="slide" onRequestClose={() => setCanvas(null)} statusBarTranslucent>
          <SafeAreaView style={styles.modalRoot}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Canvas</Text>
              <TouchableOpacity onPress={() => setCanvas(null)} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
            {canvas.html
              ? <WebView style={{ flex: 1 }} source={{ html: canvas.html }} originWhitelist={['*']} javaScriptEnabled />
              : canvas.url
              ? <WebView style={{ flex: 1 }} source={{ uri: canvas.url }} javaScriptEnabled />
              : null}
          </SafeAreaView>
        </Modal>
      )}

    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },

  // Header
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  headerBrand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerHex: { fontSize: 28, color: T.red },
  headerTitle: { fontSize: 17, fontWeight: '700', color: T.text },
  headerSub: { fontSize: 11, color: T.text3, marginTop: 1 },
  settingsBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: T.border,
  },
  settingsBtnText: { fontSize: 16, color: T.text2 },

  // Status Card
  statusCard: {
    marginHorizontal: 16, marginTop: 14, marginBottom: 0,
    borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: T.border,
  },
  statusLeft: { gap: 10 },
  statusIndicator: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pulseDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 17, fontWeight: '700' },
  statusTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: T.surface2, borderRadius: 20,
    borderWidth: 1, borderColor: T.border,
  },
  tagGreen: { borderColor: 'rgba(48,209,88,0.3)' },
  tagWarn: { borderColor: 'rgba(255,159,10,0.3)' },
  tagBlue: { borderColor: 'rgba(10,132,255,0.3)' },
  tagText: { fontSize: 12, fontWeight: '500' },

  // Controls
  controls: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4,
  },
  btnStart: {
    flex: 1, backgroundColor: T.red, borderRadius: 14,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 50,
  },
  btnStartText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnStop: {
    flex: 0.4, backgroundColor: T.surface, borderRadius: 14,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: T.border,
  },
  btnStopText: { color: T.text, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.35 },

  // Tabs
  tabBar: {
    flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  tabItem: { paddingBottom: 10, paddingHorizontal: 4, marginRight: 20 },
  tabItemActive: { borderBottomWidth: 2, borderBottomColor: T.red, marginBottom: -1 },
  tabLabel: { color: T.text3, fontSize: 15, fontWeight: '600' },
  tabLabelActive: { color: T.text },

  // Feed
  feedWrap: { flex: 1 },
  feedContent: { paddingVertical: 8 },

  emptyState: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32, gap: 10 },
  emptyHex: { fontSize: 48, color: T.text3, opacity: 0.4 },
  emptyTitle: { color: T.text2, fontSize: 17, fontWeight: '600' },
  emptySubtitle: { color: T.text3, fontSize: 14, lineHeight: 20, textAlign: 'center' },

  eventRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  eventBadge: {
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, minWidth: 36, alignItems: 'center',
  },
  eventBadgeText: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  eventText: { fontSize: 13, lineHeight: 18, flex: 1 },
  eventTs: { fontSize: 11, color: T.text3, minWidth: 36, textAlign: 'right' },

  // Files
  fileSection: {
    color: T.text2, fontSize: 13, fontWeight: '700',
    paddingHorizontal: 16, marginBottom: 8, marginTop: 4,
  },
  filePlaceholder: { color: T.text3, fontSize: 13, paddingHorizontal: 16, paddingVertical: 6 },
  fileCard: {
    marginHorizontal: 16, backgroundColor: T.surface, borderRadius: 14,
    borderWidth: 1, borderColor: T.border, overflow: 'hidden',
  },
  fileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, paddingHorizontal: 14,
  },
  fileRowDivider: { borderBottomWidth: 1, borderBottomColor: T.border },
  fileIcon: { fontSize: 16, width: 22, textAlign: 'center' },
  fileName: { color: T.text, fontSize: 14, flex: 1 },
  fileChevron: { color: T.text3, fontSize: 20 },
  pathHint: { color: T.text3, fontSize: 11, marginTop: 20, textAlign: 'center' },

  // Modals
  modalRoot: { flex: 1, backgroundColor: T.bg },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: T.border,
  },
  modalTitle: { color: T.text, fontSize: 15, fontWeight: '600', flex: 1 },
  modalCloseBtn: { paddingLeft: 16 },
  modalCloseText: { color: T.red, fontSize: 15, fontWeight: '600' },
  fileViewContent: { color: T.text, fontSize: 13, fontFamily: 'monospace', lineHeight: 20 },

  // Pairing Modal
  pairOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  pairCard: {
    width: '100%', backgroundColor: T.surface,
    borderRadius: 20, padding: 24, borderWidth: 1, borderColor: T.border,
    alignItems: 'center', gap: 12,
  },
  pairIcon: { fontSize: 36 },
  pairTitle: { fontSize: 20, fontWeight: '700', color: T.text },
  pairSubtitle: { fontSize: 14, color: T.text2, textAlign: 'center', lineHeight: 20 },
  pairInput: {
    width: '100%', backgroundColor: T.surface2,
    borderWidth: 1, borderColor: T.border, borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    color: T.text, fontSize: 28, fontWeight: '700',
    textAlign: 'center', fontFamily: 'monospace', letterSpacing: 8, marginTop: 4,
  },
  pairError: { color: T.red, fontSize: 13, textAlign: 'center' },
  pairButtons: { flexDirection: 'row', gap: 12, width: '100%', marginTop: 4 },
  pairBtn: { flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
  pairBtnIgnore: { backgroundColor: T.surface2, borderWidth: 1, borderColor: T.border },
  pairBtnIgnoreText: { color: T.text2, fontWeight: '600', fontSize: 15 },
  pairBtnConfirm: { backgroundColor: T.red },
  pairBtnConfirmText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
