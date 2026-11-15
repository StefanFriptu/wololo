import { expect, test } from 'bun:test';
import type { ToolInfo } from '../../shared/api-types.ts';
import { hasFfmpegProtocol, parseToolVersion } from './toolVersion.ts';

test.each<[ToolInfo['name'], string, string | null]>([
  [
    'ffmpeg',
    'ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc 14',
    '7.1.5-0+deb13u1',
  ],
  ['ffmpeg', 'ffmpeg version N-118000-g1234abcd Copyright (c) 2000-2026', 'N-118000-g1234abcd'],
  ['ffprobe', 'ffprobe version 9.0.2 Copyright (c) 2007-2026 the FFmpeg developers', '9.0.2'],
  ['mkvmerge', "mkvmerge v92.0 ('Everglow') 64-bit\n", '92.0'],
  ['7z', '\n7-Zip (a) 24.09 (arm64) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29\n\nFormats:', '24.09'],
  ['7z', '7-Zip [64] 16.02 : Copyright (c) 1999-2016 Igor Pavlov : 2016-05-21', '16.02'],
  ['7z', '7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov', '23.01'],
  ['nice', 'nice (GNU coreutils) 9.7\nCopyright (C) 2025 Free Software Foundation, Inc.', '9.7'],
  ['ionice', 'ionice from util-linux 2.41', '2.41'],
  ['nice', 'nice: -version: invalid nice value', null],
  ['ffmpeg', '', null],
  ['mkvmerge', 'something else entirely', null],
])('parseToolVersion - %s from %p', (name, output, expected) => {
  expect(parseToolVersion(name, output)).toBe(expected);
});

const PROTOCOLS = 'Supported file protocols:\nInput:\n  async\n  bluray\n  file\nOutput:\n  file\n';

test.each([
  ['bluray', PROTOCOLS, true],
  ['file', PROTOCOLS, true],
  ['bluray', 'Supported file protocols:\nInput:\n  async\n  file\n', false],
  ['blu', PROTOCOLS, false],
  ['bluray', '', false],
])('hasFfmpegProtocol - %s', (protocol, output, expected) => {
  expect(hasFfmpegProtocol(output, protocol)).toBe(expected);
});
