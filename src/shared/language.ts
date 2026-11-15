import type { Iso639_2 } from './domain.ts';

/** [ISO 639-2/B, ISO 639-2/T or "", ISO 639-1 or "", English names...] */
const LANGUAGES: readonly (readonly string[])[] = [
  ['afr', '', 'af', 'afrikaans'],
  ['alb', 'sqi', 'sq', 'albanian'],
  ['ara', '', 'ar', 'arabic'],
  ['arm', 'hye', 'hy', 'armenian'],
  ['baq', 'eus', 'eu', 'basque'],
  ['bel', '', 'be', 'belarusian'],
  ['ben', '', 'bn', 'bengali', 'bangla'],
  ['bos', '', 'bs', 'bosnian'],
  ['bul', '', 'bg', 'bulgarian'],
  ['bur', 'mya', 'my', 'burmese'],
  ['cat', '', 'ca', 'catalan'],
  ['chi', 'zho', 'zh', 'chinese', 'mandarin', 'cantonese'],
  ['hrv', '', 'hr', 'croatian'],
  ['cze', 'ces', 'cs', 'czech'],
  ['dan', '', 'da', 'danish'],
  ['dut', 'nld', 'nl', 'dutch', 'flemish'],
  ['eng', '', 'en', 'english'],
  ['est', '', 'et', 'estonian'],
  ['fil', '', '', 'filipino'],
  ['fin', '', 'fi', 'finnish'],
  ['fre', 'fra', 'fr', 'french'],
  ['geo', 'kat', 'ka', 'georgian'],
  ['ger', 'deu', 'de', 'german'],
  ['gle', '', 'ga', 'irish'],
  ['glg', '', 'gl', 'galician'],
  ['gre', 'ell', 'el', 'greek', 'modern greek'],
  ['guj', '', 'gu', 'gujarati'],
  ['heb', '', 'he', 'hebrew'],
  ['hin', '', 'hi', 'hindi'],
  ['hun', '', 'hu', 'hungarian'],
  ['ice', 'isl', 'is', 'icelandic'],
  ['ind', '', 'id', 'indonesian'],
  ['ita', '', 'it', 'italian'],
  ['jpn', '', 'ja', 'japanese'],
  ['kan', '', 'kn', 'kannada'],
  ['kaz', '', 'kk', 'kazakh'],
  ['khm', '', 'km', 'khmer'],
  ['kor', '', 'ko', 'korean'],
  ['kur', '', 'ku', 'kurdish'],
  ['lao', '', 'lo', 'lao'],
  ['lat', '', 'la', 'latin'],
  ['lav', '', 'lv', 'latvian'],
  ['lit', '', 'lt', 'lithuanian'],
  ['ltz', '', 'lb', 'luxembourgish'],
  ['mac', 'mkd', 'mk', 'macedonian'],
  ['may', 'msa', 'ms', 'malay'],
  ['mal', '', 'ml', 'malayalam'],
  ['mao', 'mri', 'mi', 'maori'],
  ['mar', '', 'mr', 'marathi'],
  ['mon', '', 'mn', 'mongolian'],
  ['nep', '', 'ne', 'nepali'],
  ['nor', '', 'no', 'norwegian'],
  ['nob', '', 'nb', 'norwegian bokmal', 'bokmal'],
  ['nno', '', 'nn', 'norwegian nynorsk', 'nynorsk'],
  ['pan', '', 'pa', 'punjabi', 'panjabi'],
  ['per', 'fas', 'fa', 'persian', 'farsi'],
  ['pol', '', 'pl', 'polish'],
  ['por', '', 'pt', 'portuguese'],
  ['roh', '', 'rm', 'romansh'],
  ['rum', 'ron', 'ro', 'romanian', 'moldavian'],
  ['rus', '', 'ru', 'russian'],
  ['srp', '', 'sr', 'serbian'],
  ['sin', '', 'si', 'sinhala', 'sinhalese'],
  ['slo', 'slk', 'sk', 'slovak'],
  ['slv', '', 'sl', 'slovenian', 'slovene'],
  ['spa', '', 'es', 'spanish', 'castilian', 'spanish (latino)', 'latino'],
  ['swa', '', 'sw', 'swahili'],
  ['swe', '', 'sv', 'swedish'],
  ['tgl', '', 'tl', 'tagalog'],
  ['tam', '', 'ta', 'tamil'],
  ['tel', '', 'te', 'telugu'],
  ['tha', '', 'th', 'thai'],
  ['tib', 'bod', 'bo', 'tibetan'],
  ['tur', '', 'tr', 'turkish'],
  ['ukr', '', 'uk', 'ukrainian'],
  ['urd', '', 'ur', 'urdu'],
  ['uzb', '', 'uz', 'uzbek'],
  ['vie', '', 'vi', 'vietnamese'],
  ['wel', 'cym', 'cy', 'welsh'],
  ['yid', '', 'yi', 'yiddish'],
  ['zul', '', 'zu', 'zulu'],
];

const NO_LANGUAGE = new Set(['', 'und', 'zxx', 'mis', 'unknown', 'any', 'original', 'none', 'undetermined']);

const LOOKUP: ReadonlyMap<string, Iso639_2> = new Map(
  LANGUAGES.flatMap(([code = '', ...aliases]) =>
    [code, ...aliases].filter(Boolean).map((alias): [string, Iso639_2] => [alias, code]),
  ),
);

/**
 * Pure. Any language tag or name -> ISO 639-2/B, or null when it carries no language.
 * Accepts 639-2/B ("ger"), 639-2/T ("deu"), 639-1 ("de"), BCP 47 ("de-AT", "pt-BR"), English names as
 * Radarr/Sonarr send them ("German", "Portuguese (Brazil)", "Flemish"). Unknown three-letter codes pass through.
 */
export function normalizeLanguage(value: string | null | undefined): Iso639_2 | null {
  if (value == null) return null;
  const tag = value.trim().toLowerCase();
  if (NO_LANGUAGE.has(tag)) return null;
  const known = LOOKUP.get(tag);
  if (known) return known;
  const withoutQualifier = tag.replace(/\s*\(.*\)$/, '');
  const primary = withoutQualifier.split(/[-_]/)[0] ?? '';
  const fallback = LOOKUP.get(withoutQualifier) ?? LOOKUP.get(primary);
  if (fallback) return fallback;
  if (NO_LANGUAGE.has(primary)) return null;
  return /^[a-z]{3}$/.test(primary) ? primary : null;
}

/** Pure. Language equality after normalisation ("ger" equals "deu", "de" and "German"). Null never matches. */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeLanguage(a);
  return left !== null && left === normalizeLanguage(b);
}
