/**
 * FlowChart: the cumulative Greek-flow line chart. Its accessible name is
 * the chart's name, and with fewer than two points it shows a placeholder
 * instead of a line. The placeholder is a bare div, so ARIA 1.2 prohibits
 * naming it; it is a `role="img"` whose label carries the placeholder's
 * words too, because a screen reader hides the children of an image.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlowChart } from '../../components/GreekFlowPanel/FlowChart';
import { genericElementsWithAriaLabel } from '../helpers/aria';

const CHART_NAME = 'SPY cumulative OTM Dir Delta';

describe('FlowChart accessible names', () => {
  it('names the line chart by the chart name once there are two points', () => {
    const { container } = render(
      <FlowChart values={[1, 3]} ariaLabel={CHART_NAME} />,
    );
    expect(screen.getByRole('img', { name: CHART_NAME })).toBeInTheDocument();
    expect(screen.queryByText(/waiting for/)).not.toBeInTheDocument();
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
  });

  it.each([
    ['no points', [] as number[]],
    ['one point', [4]],
  ])(
    'names the "waiting" placeholder as an image that says it is waiting (%s)',
    (_label, values) => {
      const { container } = render(
        <FlowChart values={values} ariaLabel={CHART_NAME} />,
      );
      const placeholder = screen.getByRole('img', {
        name: `${CHART_NAME}, waiting for at least 2 points`,
      });
      // The visible words stay as they were.
      expect(placeholder).toHaveTextContent('waiting for ≥2 points');
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
    },
  );
});
