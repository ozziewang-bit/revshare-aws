// Returns the caller's identity + resolved permissions (from the gate).
export async function meRoute(event) {
  const { email, name, permissions } = event.auth || {};
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, permissions }) };
}
