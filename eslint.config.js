import globals from 'globals';
import js from '@eslint/js';

export default [
	{
		files: [
			'src/**/*.js',
			'examples/**/*.js'
		],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		rules: {
			...js.configs.recommended.rules,
			'no-unused-vars': [
			'warn',
			{
				'args': 'all',
				'vars': 'all',
				'caughtErrors': 'all',
				'argsIgnorePattern': '^_',
				'varsIgnorePattern': '^_',
				'caughtErrorsIgnorePattern': '^_'
			}
			],
			'indent': [
				'warn',
				'tab',
				{
					'SwitchCase': 1
				}
			],
			'quotes': [
				'warn',
				'single'
			],
			'semi': [
				'warn',
				'always'
			],
			'no-empty': 'off',
			'multiline-comment-style': 0
		}
	}
];
