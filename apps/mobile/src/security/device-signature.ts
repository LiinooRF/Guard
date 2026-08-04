import { CryptoDigestAlgorithm, digest, getRandomBytesAsync, randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'voxia.device-signature.id.v1';
const SECRET_KEY = 'voxia.device-signature.secret.v1';

export interface DatosFirmablesEscaneo {
  readonly clientScanId: string;
  readonly deviceId: string;
  readonly uid: string;
  readonly method: 'nfc' | 'qr';
  readonly scannedAt: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracyM?: number;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function contenidoFirmado(input: DatosFirmablesEscaneo): string {
  return JSON.stringify([
    'v1', input.clientScanId, input.deviceId, input.uid.trim(), input.method,
    input.scannedAt, input.latitude ?? null, input.longitude ?? null, input.accuracyM ?? null,
  ]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Expo acepta BufferSource, pero TypeScript 6 distingue ArrayBuffer de
  // SharedArrayBuffer. La copia garantiza un ArrayBuffer propio y exacto.
  const input = Uint8Array.from(bytes).buffer;
  return new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, input));
}

async function hmacSha256(key: Uint8Array, message: string): Promise<string> {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? await sha256(key) : key);
  const inner = block.map((byte) => byte ^ 0x36);
  const outer = block.map((byte) => byte ^ 0x5c);
  const encoded = new TextEncoder().encode(message);
  const innerInput = new Uint8Array(inner.length + encoded.length);
  innerInput.set(inner);
  innerInput.set(encoded, inner.length);
  const innerHash = await sha256(innerInput);
  const outerInput = new Uint8Array(outer.length + innerHash.length);
  outerInput.set(outer);
  outerInput.set(innerHash, outer.length);
  return hex(await sha256(outerInput));
}

async function identidad() {
  let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  let secretHex = await SecureStore.getItemAsync(SECRET_KEY);
  if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
    deviceId = randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  if (!secretHex || !/^[0-9a-f]{64}$/i.test(secretHex)) {
    secretHex = hex(await getRandomBytesAsync(32));
    await SecureStore.setItemAsync(SECRET_KEY, secretHex, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  return { deviceId, secret: bytesHex(secretHex) };
}

export async function firmarEscaneo(
  input: Omit<DatosFirmablesEscaneo, 'clientScanId' | 'deviceId'>,
) {
  const { deviceId, secret } = await identidad();
  const datos = { ...input, clientScanId: randomUUID(), deviceId };
  return { ...datos, signature: await hmacSha256(secret, contenidoFirmado(datos)) };
}

export async function registrarClaveDispositivo(apiUrl: string, portalOrigin: string) {
  const { deviceId, secret } = await identidad();
  const respuesta = await fetch(`${apiUrl.replace(/\/$/, '')}/guard/device-signing-key`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Voxia-Client': 'mobile',
      Origin: portalOrigin,
    },
    body: JSON.stringify({ deviceId, key: base64(secret) }),
  });
  if (!respuesta.ok) throw new Error(`device-key_${respuesta.status}`);
  return deviceId;
}
