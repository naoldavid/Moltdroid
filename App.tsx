import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsProvider, useSettings } from './src/context/SettingsContext';
import TermsScreen    from './src/screens/onboarding/TermsScreen';
import WelcomeScreen  from './src/screens/onboarding/WelcomeScreen';
import ProviderScreen from './src/screens/onboarding/ProviderScreen';
import ApiKeyScreen   from './src/screens/onboarding/ApiKeyScreen';
import TelegramScreen from './src/screens/onboarding/TelegramScreen';
import BatteryScreen  from './src/screens/onboarding/BatteryScreen';
import HomeScreen     from './src/screens/HomeScreen';
import SettingsScreen from './src/screens/SettingsScreen';

type Screen =
  | 'loading'
  | 'terms'
  | 'welcome'
  | 'provider'
  | 'apikey'
  | 'telegram'
  | 'battery'
  | 'home'
  | 'settings';

function AppNavigator() {
  const { settings, loaded, save } = useSettings();
  const [screen, setScreen] = useState<Screen>('loading');

  useEffect(() => {
    if (!loaded) return;
    if (!settings.termsAccepted) {
      setScreen('terms');
    } else if (!settings.onboarded) {
      setScreen('welcome');
    } else {
      setScreen('home');
    }
  }, [loaded, settings.termsAccepted, settings.onboarded]);

  if (screen === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#E8202A" />
      </View>
    );
  }

  switch (screen) {
    case 'terms':
      return (
        <TermsScreen
          onAccept={async () => {
            await save({ termsAccepted: true });
            setScreen(settings.onboarded ? 'home' : 'welcome');
          }}
        />
      );

    case 'welcome':
      return <WelcomeScreen onNext={() => setScreen('provider')} />;

    case 'provider':
      return (
        <ProviderScreen
          onNext={() => setScreen('apikey')}
          onBack={() => setScreen('welcome')}
        />
      );

    case 'apikey':
      return (
        <ApiKeyScreen
          onNext={() => setScreen('telegram')}
          onBack={() => setScreen('provider')}
        />
      );

    case 'telegram':
      return (
        <TelegramScreen
          onNext={() => setScreen('battery')}
          onBack={() => setScreen('apikey')}
        />
      );

    case 'battery':
      return (
        <BatteryScreen
          onNext={async () => {
            await save({ onboarded: true });
            setScreen('home');
          }}
          onBack={() => setScreen('telegram')}
        />
      );

    case 'home':
      return <HomeScreen onOpenSettings={() => setScreen('settings')} />;

    case 'settings':
      return (
        <SettingsScreen
          onBack={() => setScreen('home')}
          onResetOnboarding={() => setScreen('terms')}
        />
      );

    default:
      return null;
  }
}

function FadeInView({ children }: { children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(14)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1, duration: 450, delay: 60,
        easing: Easing.out(Easing.ease), useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0, duration: 380, delay: 60,
        easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[{ flex: 1 }, { opacity, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SettingsProvider>
        <FadeInView>
          <AppNavigator />
        </FadeInView>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center' },
});
