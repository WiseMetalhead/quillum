function normalizedIdentityParts(username: string, email: string) {
  return [username, email.split('@')[0]]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3)
}

export function passwordRequirements(
  password: string,
  username: string,
  email: string,
  labels: [string, string, string],
) {
  const normalizedPassword = password.toLowerCase()
  const identityParts = normalizedIdentityParts(username, email)

  return [
    { label: labels[0], met: password.length >= 12 },
    {
      label: labels[1],
      met: /[A-Za-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password),
    },
    {
      label: labels[2],
      met: password.length > 0 && !identityParts.some(
        (part) => normalizedPassword.includes(part) || part.includes(normalizedPassword),
      ),
    },
  ]
}
