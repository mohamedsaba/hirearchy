const config = {
  important: true,
  content: ['./apps/web/app/**/*.{ts,tsx}', './apps/web/src/ui/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        plum: '#211426',
        'plum-elevated': '#2B1B32',
        slate: '#3A2644',
        mint: '#8EE3B8',
        cream: '#F5EFE6',
        coral: '#E85D56',
      },
    },
  },
};

export default config;
