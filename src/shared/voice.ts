// Shared by the engine and the renderer: voice dictation's settings, the models it can use and where they come from.
// No Node imports. Speech is turned into text on this computer by a Whisper model; the model files are downloaded once,
// only after the user agrees, from the pinned addresses below.

export type VoiceModelId = 'whisper-base' | 'whisper-small'

/** "Voice input": whether the mic buttons show, the model, the spoken language ('auto', which Whisper here takes as English, or a Whisper code) and the microphone ('' is the system default). */
export interface VoiceSettings {
  enabled: boolean
  model: VoiceModelId
  language: string
  microphone: string
}

export const VOICE_DEFAULTS: VoiceSettings = { enabled: true, model: 'whisper-base', language: 'auto', microphone: '' }

/** The longest microphone device id kept. */
export const VOICE_MICROPHONE_MAX = 256

export interface VoiceModelFile {
  /** The path inside the repository and inside the model's folder. */
  path: string
  size: number
  sha256: string
}

export interface VoiceModelSpec {
  id: VoiceModelId
  label: string
  /** A Hugging Face repository, and the exact commit of it the files are taken from. */
  repo: string
  revision: string
  files: VoiceModelFile[]
}

const base = {
  repo: 'onnx-community/whisper-base',
  revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c'
}
const small = {
  repo: 'onnx-community/whisper-small',
  revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732'
}

// Both models: the encoder at full precision (it is sensitive to quantizing) and the decoder in 4 bits, which runs on
// the GPU and on the CPU alike. The dtype choice lives in the worker.
export const VOICE_MODELS: VoiceModelSpec[] = [
  {
    id: 'whisper-base',
    label: 'Whisper base',
    ...base,
    files: [
      { path: 'config.json', size: 2243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b' },
      { path: 'generation_config.json', size: 3832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', size: 282682, sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573' },
      { path: 'onnx/encoder_model.onnx', size: 82468078, sha256: 'a9f3b752833b49e880dec91ee5b6d936112be7c3ea07c221024ba493439f46fe' },
      { path: 'onnx/decoder_model_merged_q4.onnx', size: 123602419, sha256: '09f83b71ceedc97dab1d90b914715dc532a646a147abda11d83c64867b7c319c' }
    ]
  },
  {
    id: 'whisper-small',
    label: 'Whisper small',
    ...small,
    files: [
      { path: 'config.json', size: 2227, sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
      { path: 'generation_config.json', size: 3893, sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', size: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model.onnx', size: 352825870, sha256: 'b37cd6625dc36f9178ec7539a1876b9680ea26a910097e092be39dc766320c7b' },
      { path: 'onnx/decoder_model_merged_q4.onnx', size: 233149327, sha256: '795c61b344576719c2b249cc9911c78b4cc552c8c6a5407be21a3380a0791b13' }
    ]
  }
]

export function isVoiceModelId(v: unknown): v is VoiceModelId {
  return VOICE_MODELS.some((m) => m.id === v)
}

export function voiceModelSize(spec: VoiceModelSpec): number {
  return spec.files.reduce((sum, f) => sum + f.size, 0)
}

/** The address a model file is downloaded from. */
export function voiceModelSourceUrl(spec: Pick<VoiceModelSpec, 'repo' | 'revision'>, file: string): string {
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file}`
}

/** One model's state on disk: installed, or being downloaded (`download`), or what went wrong last. */
export interface VoiceModelStatus {
  id: VoiceModelId
  installed: boolean
  download: { loaded: number; total: number } | null
  error: string | null
}

/** Ctrl+Shift+Space while a long-form field has focus. Neither Windows nor Mainbus uses it for anything else. */
export const DICTATION_SHORTCUT = 'Ctrl+Shift+Space'

/** Whisper's languages by code. */
export const WHISPER_LANGUAGES: Record<string, string> = {
  af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', as: 'Assamese', az: 'Azerbaijani', ba: 'Bashkir', be: 'Belarusian', bg: 'Bulgarian',
  bn: 'Bengali', bo: 'Tibetan', br: 'Breton', bs: 'Bosnian', ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish', de: 'German',
  el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', eu: 'Basque', fa: 'Persian', fi: 'Finnish', fo: 'Faroese', fr: 'French',
  gl: 'Galician', gu: 'Gujarati', ha: 'Hausa', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', ht: 'Haitian Creole',
  hu: 'Hungarian', hy: 'Armenian', id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese', jw: 'Javanese', ka: 'Georgian',
  kk: 'Kazakh', km: 'Khmer', kn: 'Kannada', ko: 'Korean', la: 'Latin', lb: 'Luxembourgish', ln: 'Lingala', lo: 'Lao', lt: 'Lithuanian',
  lv: 'Latvian', mg: 'Malagasy', mi: 'Maori', mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian', mr: 'Marathi', ms: 'Malay',
  mt: 'Maltese', my: 'Myanmar', ne: 'Nepali', nl: 'Dutch', nn: 'Nynorsk', no: 'Norwegian', oc: 'Occitan', pa: 'Punjabi', pl: 'Polish',
  ps: 'Pashto', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sa: 'Sanskrit', sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak',
  sl: 'Slovenian', sn: 'Shona', so: 'Somali', sq: 'Albanian', sr: 'Serbian', su: 'Sundanese', sv: 'Swedish', sw: 'Swahili',
  ta: 'Tamil', te: 'Telugu', tg: 'Tajik', th: 'Thai', tk: 'Turkmen', tl: 'Tagalog', tr: 'Turkish', tt: 'Tatar', uk: 'Ukrainian',
  ur: 'Urdu', uz: 'Uzbek', vi: 'Vietnamese', yi: 'Yiddish', yo: 'Yoruba', zh: 'Chinese'
}

export function isVoiceLanguage(v: unknown): v is string {
  return v === 'auto' || (typeof v === 'string' && Object.prototype.hasOwnProperty.call(WHISPER_LANGUAGES, v))
}
