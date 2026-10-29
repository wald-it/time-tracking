import { describe, expect, it } from 'vitest'
import { BOUNDS_MS, judgePerformance, type PerformanceReport } from './performanceMeasurement'

function report(monthEntries: number, buildAnalyticsSummary: number): PerformanceReport {
  return { medians: { monthEntries, buildAnalyticsSummary } } as PerformanceReport
}

describe('P7 absolute performance bounds (owner decision 2026-10-29)', () => {
  const baseline = report(1.3, 20)

  it('passes when both medians are under their bounds', () => {
    const verdicts = judgePerformance(baseline, report(14, 150))
    expect(verdicts.map((v) => v.pass)).toEqual([true, true])
    expect(verdicts[1].line).toBe(
      'buildAnalyticsSummary: v1.23.2=20.000 ms; 2.0=150.000 ms; ratio=7.500; bound < 200 ms; PASS'
    )
  })

  it('fails when the analytics median is 200 ms or more, whatever the ratio', () => {
    const verdicts = judgePerformance(baseline, report(14, 200.5))
    expect(verdicts[1].pass).toBe(false)
    expect(verdicts[1].line).toContain('bound < 200 ms; FAIL')
    expect(judgePerformance(baseline, report(14, 200))[1].pass).toBe(false)
  })

  it('fails when the month view median is 50 ms or more', () => {
    expect(judgePerformance(baseline, report(50, 10))[0].pass).toBe(false)
  })

  it('does not use the ratio to decide: a high ratio under the bound passes', () => {
    expect(judgePerformance(report(1, 1), report(40, 199))[1].pass).toBe(true)
    expect(BOUNDS_MS).toEqual({ monthEntries: 50, buildAnalyticsSummary: 200 })
  })
})
