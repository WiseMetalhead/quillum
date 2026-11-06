export function resolveApiBase(
  explicitBase: string | undefined,
  development: boolean,
  hostname: string,
) {
  if (explicitBase !== undefined) return explicitBase
  return development ? `http://${hostname}:8000` : ''
}
