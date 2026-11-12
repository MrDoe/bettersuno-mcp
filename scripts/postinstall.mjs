#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupOpencodeConfig } from '../src/opencode-setup.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
setupOpencodeConfig({ scope: 'auto', packageDir });
