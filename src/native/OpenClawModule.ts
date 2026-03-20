import { NativeModules, NativeEventEmitter } from 'react-native';

const { OpenClawModule: _Module } = NativeModules;

if (!_Module) {
  throw new Error(
    'OpenClawModule not found. Did you rebuild the native Android project?'
  );
}

export const OpenClawModule = {
  startService: (): void => _Module.startService(),
  stopService: (): void => _Module.stopService(),

  isIgnoringBatteryOptimizations: (): Promise<boolean> =>
    new Promise((resolve) => _Module.isIgnoringBatteryOptimizations(resolve)),

  requestBatteryOptimizationWhitelist: (): void =>
    _Module.requestBatteryOptimizationWhitelist(),

  getFilesDir: (): Promise<string> => _Module.getFilesDir(),

  showNotification: (title: string, body: string): void =>
    _Module.showNotification(title, body),
};

export const openClawEmitter = new NativeEventEmitter(_Module);
