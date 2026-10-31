import { describe, expect, it } from 'vitest'
import { CLIENT_REVENUE_SHARE_THRESHOLD, nonBillableShare, revenueShare } from './clientShares'

describe('client shares', () => {
  it.each([
    [7200, 5400, 0.25],
    [3600, 3600, 0],
    [3600, 0, 1],
    [0, 0, null]
  ])('non-billable share of %s worked / %s billable seconds is %s', (h, b, expected) => {
    expect(nonBillableShare(h!, b!)).toBe(expected)
  })

  it('uses all clients, including those outside the four visible named rows', () => {
    const clients = [840_000, 10_000, 0, 0, 100_000, 50_000].map((rev) => ({ rev }))
    expect(revenueShare(clients[0].rev, clients)).toBe(0.84)
    expect(revenueShare(150_000, clients)).toBe(0.15) // Other, same denominator
    expect(revenueShare(0, clients)).toBe(0)
  })

  it('has no revenue share for zero total revenue or an empty window', () => {
    expect(revenueShare(0, [{ rev: 0 }, { rev: 0 }])).toBeNull()
    expect(revenueShare(0, [])).toBeNull()
  })

  it('places the DRV reference mark at exactly five sixths', () => {
    expect(CLIENT_REVENUE_SHARE_THRESHOLD).toBe(5 / 6)
  })
})
