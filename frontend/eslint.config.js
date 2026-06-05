import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // The following react-hooks 7.x rules don't fit react-three-fiber:
      //   - Three.js objects (BufferGeometry, ShaderMaterial, DataTexture,
      //     Float32Array buffers) are mutable by design and we drive them
      //     from useFrame, which the rule treats as forbidden mutation.
      //   - Derived-state-in-effect is the standard pattern for expensive
      //     per-frame derivations like trilateration; useMemo can't replace
      //     it when there are also side effects on internal layout maps.
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
])
