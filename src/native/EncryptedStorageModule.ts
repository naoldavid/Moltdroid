import { NativeModules } from 'react-native';

const { EncryptedStorageModule } = NativeModules;

export default {
  setItem: (key: string, value: string): Promise<void> =>
    EncryptedStorageModule.setItem(key, value),
  getItem: (key: string): Promise<string | null> =>
    EncryptedStorageModule.getItem(key),
  deleteItem: (key: string): Promise<void> =>
    EncryptedStorageModule.deleteItem(key),
  clear: (): Promise<void> =>
    EncryptedStorageModule.clear(),
};
