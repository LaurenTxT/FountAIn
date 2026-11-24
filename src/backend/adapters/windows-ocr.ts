import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const ocrCache = new Map<string, string>();
const MAX_CACHE = 64;
const MAX_OCR_CHARS = 6000;

const OCR_PS_SCRIPT = [
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
  'function Await($op, $type) {',
  '  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1" })[0]',
  '  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))',
  '  $task.Wait()',
  '  return $task.Result',
  '}',
  '$imgPath = $env:FOUNTAIN_OCR_IMAGE_PATH',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if ($null -eq $engine) { exit 0 }',
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '$stream.Dispose()',
  '$bitmap.Dispose()',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$result.Lines | ForEach-Object { $_.Text }',
].join('\n');

const OCR_ENCODED = Buffer.from(OCR_PS_SCRIPT, 'utf16le').toString('base64');

/** Extract text from a local image using Windows 11 built-in offline OCR; never throws. */
export function ocrImageLocal(imagePath: string): string {
  if (process.platform !== 'win32') return '';
  let cacheKey = imagePath;
  try {
    const info = statSync(imagePath);
    cacheKey = `${imagePath}:${info.size}:${info.mtimeMs}`;
  } catch {
    return '';
  }
  if (ocrCache.has(cacheKey)) return ocrCache.get(cacheKey)!;

  try {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', OCR_ENCODED],
      {
        encoding: 'utf8',
        timeout: 12_000,
        windowsHide: true,
        env: { ...process.env, FOUNTAIN_OCR_IMAGE_PATH: imagePath },
      },
    );
    const text = result.status === 0 ? (result.stdout ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_OCR_CHARS) : '';
    if (ocrCache.size >= MAX_CACHE) {
      const oldest = ocrCache.keys().next().value;
      if (oldest) ocrCache.delete(oldest);
    }
    ocrCache.set(cacheKey, text);
    return text;
  } catch {
    return '';
  }
}
