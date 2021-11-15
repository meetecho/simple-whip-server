module.exports = {
    'env': {
        'node': true,
        'browser': false,
        'es2020': true
    },
    'extends': 'eslint:recommended',
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
