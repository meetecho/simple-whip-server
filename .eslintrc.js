module.exports = {
    'env': {
        'node': true,
        'browser': true,
        'jquery': true,
        'es2021': true
    },
    'extends': [
        'eslint:recommended'
    ],
    'parserOptions': {
        'sourceType': 'module'
    },
    'rules': {
        'no-unused-vars': [
            'warn',
            {
                'vars': 'all',
                'args': 'all',
                'argsIgnorePattern': '^_',
                'varsIgnorePattern': '^_'
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
        'no-empty': 'off'
    }
};
