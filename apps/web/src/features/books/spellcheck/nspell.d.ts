declare module 'nspell' {
  export type NSpell = {
    correct: (word: string) => boolean
    suggest: (word: string) => string[]
  }

  export default function nspell(dictionary: { aff: string; dic: string }): NSpell
}
