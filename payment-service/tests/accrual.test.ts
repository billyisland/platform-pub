import { describe, it, expect } from 'vitest'
import { classifyRead } from '../src/services/accrual.js'

describe('classifyRead', () => {
  describe('reader with card (accrued)', () => {
    it('returns accrued state', () => {
      const result = classifyRead(true, 500, 10)
      expect(result.readState).toBe('accrued')
    })

    it('is never on free allowance', () => {
      const result = classifyRead(true, 500, 10)
      expect(result.onFreeAllowance).toBe(false)
    })

    it('never exhausts allowance', () => {
      const result = classifyRead(true, 500, 600)
      expect(result.allowanceJustExhausted).toBe(false)
    })
  })

  describe('reader without card (provisional)', () => {
    it('returns provisional state', () => {
      const result = classifyRead(false, 500, 10)
      expect(result.readState).toBe('provisional')
    })

    it('is on free allowance when allowance > 0', () => {
      const result = classifyRead(false, 500, 10)
      expect(result.onFreeAllowance).toBe(true)
    })

    it('is not on free allowance when allowance is 0', () => {
      const result = classifyRead(false, 0, 10)
      expect(result.onFreeAllowance).toBe(false)
    })

    it('is not on free allowance when allowance is negative', () => {
      const result = classifyRead(false, -50, 10)
      expect(result.onFreeAllowance).toBe(false)
    })
  })

  describe('allowance exhaustion boundary', () => {
    it('triggers when amount exactly equals remaining allowance', () => {
      const result = classifyRead(false, 100, 100)
      expect(result.allowanceJustExhausted).toBe(true)
    })

    it('triggers when amount exceeds remaining allowance', () => {
      const result = classifyRead(false, 50, 100)
      expect(result.allowanceJustExhausted).toBe(true)
    })

    it('does not trigger when allowance has room left', () => {
      const result = classifyRead(false, 200, 100)
      expect(result.allowanceJustExhausted).toBe(false)
    })

    it('does not trigger when allowance is already 0', () => {
      const result = classifyRead(false, 0, 100)
      expect(result.allowanceJustExhausted).toBe(false)
    })

    it('does not trigger when allowance is already negative', () => {
      const result = classifyRead(false, -50, 100)
      expect(result.allowanceJustExhausted).toBe(false)
    })

    it('does not trigger for a reader with a card', () => {
      const result = classifyRead(true, 100, 100)
      expect(result.allowanceJustExhausted).toBe(false)
    })
  })
})
