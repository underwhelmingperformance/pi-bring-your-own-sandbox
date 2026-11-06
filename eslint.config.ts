import path from 'node:path';

import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import oxlint from 'eslint-plugin-oxlint';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig(
	{ ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
	eslint.configs.recommended,
	ts.configs.strictTypeChecked,
	ts.configs.stylisticTypeChecked,
	unicorn.configs.recommended,
	eslintConfigPrettier,
	{
		plugins: {
			'@stylistic': stylistic,
			'simple-import-sort': simpleImportSort
		},
		languageOptions: {
			globals: globals.node,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			curly: ['error', 'all'],
			'@stylistic/lines-between-class-members': [
				'error',
				{
					enforce: [
						{ blankLine: 'always', prev: '*', next: 'method' },
						{ blankLine: 'always', prev: 'method', next: '*' }
					]
				}
			],
			'@stylistic/padding-line-between-statements': [
				'error',
				{ blankLine: 'always', prev: '*', next: ['const', 'let', 'var'] },
				{ blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
				{
					blankLine: 'any',
					prev: ['const', 'let', 'var'],
					next: ['const', 'let', 'var']
				},
				{
					blankLine: 'always',
					prev: '*',
					next: [
						'return',
						'throw',
						'if',
						'switch',
						'for',
						'while',
						'do',
						'try',
						'function',
						'class'
					]
				},
				{ blankLine: 'always', prev: 'block-like', next: '*' }
			],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			'simple-import-sort/imports': [
				'error',
				{
					groups: [
						[String.raw`^\u0000`],
						['^node:'],
						[String.raw`^@?\w`],
						[String.raw`^\.\.`],
						[String.raw`^\.`]
					]
				}
			],
			'simple-import-sort/exports': 'error'
		}
	},
	await oxlint.buildFromConfigFile(
		path.join(import.meta.dirname, '.oxlintrc.json')
	)
);
