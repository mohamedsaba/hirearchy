const inheritedOperatingSystemFields = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
];

export function createLocalAppEnvironment(
  parentEnvironment,
  stagingEnvironment,
) {
  const environment = {};
  for (const name of inheritedOperatingSystemFields) {
    const value = parentEnvironment[name];
    if (typeof value === 'string') environment[name] = value;
  }
  return { ...environment, ...stagingEnvironment };
}
