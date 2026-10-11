/**
 * The gallery layout.
 *
 * A responsive grid of the same `RowCard` the board uses, sized by
 * `config.cardSize`. `auto-fill` rather than a fixed column count, so the grid
 * reflows with the inline block's width instead of overflowing it.
 */

import { CARD_WIDTH, cardSizeOf } from "./grouping";
import { RowCard, type BaseLayoutProps } from "./CardBits";

export function GalleryView(props: BaseLayoutProps): JSX.Element {
  const { columns, rows, config, locked } = props;
  const width = CARD_WIDTH[cardSizeOf(config.cardSize)];

  return (
    <div
      className="dbgallery"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${width}px, 1fr))` }}
    >
      {rows.map((row) => (
        <RowCard
          key={row.page.id}
          row={row}
          columns={columns}
          onOpen={() => props.onOpenRow(row)}
          onOpenPage={props.onOpenPage}
        />
      ))}
      <button
        type="button"
        className="dbgallery__new"
        disabled={locked}
        onClick={() => props.onNewRow()}
      >
        + New
      </button>
    </div>
  );
}
