// Copyright (c) 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../common/common.js';
import * as Host from '../../host/host.js';
import * as Platform from '../../platform/platform.js';
import * as LitHtml from '../../third_party/lit-html/lit-html.js';
// eslint-disable-next-line rulesdir/es_modules_import
import * as UI from '../../ui/ui.js';

import {calculateColumnWidthPercentageFromWeighting, calculateFirstFocusableCell, Cell, CellPosition, Column, getRowEntryForColumnId, handleArrowKeyNavigation, keyIsArrowKey, renderCellValue, Row, SortDirection, SortState} from './DataGridUtils.js';

export interface DataGridContextMenusConfiguration {
  headerRow?: (menu: UI.ContextMenu.ContextMenu, columns: readonly Column[]) => void;
  bodyRow?: (menu: UI.ContextMenu.ContextMenu, columns: readonly Column[], row: Readonly<Row>) => void;
}

export interface DataGridData {
  columns: Column[];
  rows: Row[];
  activeSort: SortState|null;
  contextMenus?: DataGridContextMenusConfiguration;
}

export class ColumnHeaderClickEvent extends Event {
  data: {
    column: Column,
    columnIndex: number,
  };

  constructor(column: Column, columnIndex: number) {
    super('column-header-click');
    this.data = {
      column,
      columnIndex,
    };
  }
}

export class BodyCellFocusedEvent extends Event {
  /**
   * Although the DataGrid cares only about the focused cell, and has no concept
   * of a focused row, many components that render a data grid want to know what
   * row is active, so on the cell focused event we also send the row that the
   * cell is part of.
   */
  data: {
    cell: Cell,
    row: Row,
  };

  constructor(cell: Cell, row: Row) {
    super('cell-focused');
    this.data = {
      cell,
      row,
    };
  }
}

export class ContextMenuColumnSortClickEvent extends Event {
  data: {
    column: Column,
  };

  constructor(column: Column) {
    super('context-menu-column-sort-click');
    this.data = {
      column,
    };
  }
}

const KEYS_TREATED_AS_CLICKS = new Set([' ', 'Enter']);

export class DataGrid extends HTMLElement {
  private readonly shadow = this.attachShadow({mode: 'open'});
  private columns: readonly Column[] = [];
  private rows: readonly Row[] = [];
  private sortState: Readonly<SortState>|null = null;
  private contextMenus?: DataGridContextMenusConfiguration;
  private currentResize: {
    rightCellCol: HTMLTableColElement,
    leftCellCol: HTMLTableColElement,
    leftCellColInitialPercentageWidth: number,
    rightCellColInitialPercentageWidth: number,
    initialLeftCellWidth: number,
    initialRightCellWidth: number,
    initialMouseX: number,
    documentForCursorChange: Document,
    cursorToRestore: string,
  }|null = null;

  // These have to be bound as they are put onto the global document, not onto
  // this element, so LitHtml does not bind them for us.
  private boundOnResizePointerUp = this.onResizePointerUp.bind(this);
  private boundOnResizePointerMove = this.onResizePointerMove.bind(this);
  private boundOnResizePointerDown = this.onResizePointerDown.bind(this);

  /**
   * Following guidance from
   * https://www.w3.org/TR/wai-aria-practices/examples/grid/dataGrids.html, we
   * allow a single cell inside the table to be focusable, such that when a user
   * tabs in they select that cell. IMPORTANT: if the data-grid has sortable
   * columns, the user has to be able to navigate to the headers to toggle the
   * sort. [0,0] is considered the first cell INCLUDING the column header
   * Therefore if a user is on the first header cell, the position is considered [0, 0],
   * and if a user is on the first body cell, the position is considered [0, 1].
   *
   * We set the selectable cell to the first tbody value by default, but then on the
   * first render if any of the columns are sortable we'll set the active cell
   * to [0, 0].
   */
  private focusableCell: CellPosition = [0, 1];
  private hasRenderedAtLeastOnce = false;

  get data(): DataGridData {
    return {
      columns: this.columns as Column[],
      rows: this.rows as Row[],
      activeSort: this.sortState,
      contextMenus: this.contextMenus,
    };
  }

  set data(data: DataGridData) {
    this.columns = data.columns;
    this.rows = data.rows;
    this.sortState = data.activeSort;
    this.contextMenus = data.contextMenus;

    /**
     * On first render, now we have data, we can figure out which cell is the
     * focusable cell for the table.
     *
     * If any columns are sortable, we pick [0, 0], which is the first cell of
     * the columns row. However, if any columns are hidden, we adjust
     * accordingly. e.g., if the first column is hidden, we'll set the starting
     * index as [1, 0].
     *
     * If the columns aren't sortable, we pick the first visible body row as the
     * index.
     *
     * We only do this on the first render; otherwise if we re-render and the
     * user has focused a cell, this logic will reset it.
     */
    if (!this.hasRenderedAtLeastOnce) {
      this.focusableCell = calculateFirstFocusableCell({columns: this.columns, rows: this.rows});
    }

    if (this.hasRenderedAtLeastOnce) {
      const [selectedColIndex, selectedRowIndex] = this.focusableCell;
      const columnOutOfBounds = selectedColIndex > this.columns.length;
      const rowOutOfBounds = selectedRowIndex > this.rows.length;

      /** If the row or column was removed, so the user is out of bounds, we
       * move them to the last focusable cell, which should be close to where
       * they were. */
      if (columnOutOfBounds || rowOutOfBounds) {
        this.focusableCell = [
          columnOutOfBounds ? this.columns.length : selectedColIndex,
          rowOutOfBounds ? this.rows.length : selectedRowIndex,
        ];
      } else {
        /** If the user was on some cell that is now hidden, the logic to figure out the best cell to move them to is complex. We're deferring this for now and instead reset them back to the first focusable cell. */
        this.focusableCell = calculateFirstFocusableCell({columns: this.columns, rows: this.rows});
      }
    }

    this.render();
  }

  private scrollToBottomIfRequired(): void {
    if (this.hasRenderedAtLeastOnce === false) {
      // On the first render we don't want to assume the user wants to scroll to the bottom;
      return;
    }

    const focusableCell = this.getCurrentlyFocusableCell();
    if (focusableCell && focusableCell === this.shadow.activeElement) {
      // The user has a cell (and indirectly, a row) selected so we don't want
      // to mess with their scroll
      return;
    }

    // Scroll to the bottom, but pick the last visible row, not the last entry
    // of this.rows, which might be hidden.
    const lastVisibleRow = this.shadow.querySelector('tbody tr:not(.hidden):last-child');
    if (lastVisibleRow) {
      lastVisibleRow.scrollIntoView();
    }
  }

  private getCurrentlyFocusableCell(): HTMLTableCellElement|null {
    const [columnIndex, rowIndex] = this.focusableCell;
    const cell = this.shadow.querySelector<HTMLTableCellElement>(
        `[data-row-index="${rowIndex}"][data-col-index="${columnIndex}"]`);
    return cell;
  }

  private focusCell([newColumnIndex, newRowIndex]: CellPosition): void {
    const [currentColumnIndex, currentRowIndex] = this.focusableCell;
    const newCellIsCurrentlyFocusedCell = (currentColumnIndex === newColumnIndex && currentRowIndex === newRowIndex);

    if (!newCellIsCurrentlyFocusedCell) {
      this.focusableCell = [newColumnIndex, newRowIndex];
    }

    const cellElement = this.getCurrentlyFocusableCell();
    if (!cellElement) {
      throw new Error('Unexpected error: could not find cell marked as focusable');
    }
    /* The cell may already be focused if the user clicked into it, but we also
     * add arrow key support, so in the case where we're programatically moving the
     * focus, ensure we actually focus the cell.
     */
    cellElement.focus();
    this.render();
  }

  private onTableKeyDown(event: KeyboardEvent): void {
    const key = event.key;

    if (KEYS_TREATED_AS_CLICKS.has(key)) {
      const focusedCell = this.getCurrentlyFocusableCell();
      const [focusedColumnIndex, focusedRowIndex] = this.focusableCell;
      const activeColumn = this.columns[focusedColumnIndex];
      if (focusedCell && focusedRowIndex === 0 && activeColumn && activeColumn.sortable) {
        this.onColumnHeaderClick(activeColumn, focusedColumnIndex);
      }
    }

    if (!keyIsArrowKey(key)) {
      return;
    }

    const nextFocusedCell = handleArrowKeyNavigation({
      key: key,
      currentFocusedCell: this.focusableCell,
      columns: this.columns,
      rows: this.rows,
    });
    this.focusCell(nextFocusedCell);
  }

  private onColumnHeaderClick(col: Column, index: number): void {
    this.dispatchEvent(new ColumnHeaderClickEvent(col, index));
  }

  /**
   * Applies the aria-sort label to a column's th.
   * Guidance on values of attribute taken from
   * https://www.w3.org/TR/wai-aria-practices/examples/grid/dataGrids.html.
   */
  private ariaSortForHeader(col: Column): string|undefined {
    if (col.sortable && (!this.sortState || this.sortState.columnId !== col.id)) {
      // Column is sortable but is not currently sorted
      return 'none';
    }

    if (this.sortState && this.sortState.columnId === col.id) {
      return this.sortState.direction === SortDirection.ASC ? 'ascending' : 'descending';
    }

    // Column is not sortable, so don't apply any label
    return undefined;
  }


  private renderFillerRow(): LitHtml.TemplateResult {
    const emptyCells = this.columns.map((col, colIndex) => {
      if (!col.visible) {
        return LitHtml.nothing;
      }
      const emptyCellClasses = LitHtml.Directives.classMap({
        firstVisibleColumn: colIndex === 0,
      });
      return LitHtml.html`<td tabindex="-1" class=${emptyCellClasses} data-filler-row-column-index=${colIndex}>
    ${this.renderResizeForCell([colIndex + 1, this.rows.length])}</td>`;
    });
    return LitHtml.html`<tr tabindex="-1" class="filler-row">${emptyCells}</tr>`;
  }

  private cleanUpAfterResizeColumnComplete(): void {
    if (!this.currentResize) {
      return;
    }
    this.currentResize.documentForCursorChange.body.style.cursor = this.currentResize.cursorToRestore;
    this.currentResize = null;
  }

  private onResizePointerDown(event: PointerEvent): void {
    if (event.buttons !== 1 || (Host.Platform.isMac() && event.ctrlKey)) {
      // Ensure we only react to a left click drag mouse down event.
      // On Mac we ignorre Ctrl-click which can be used to bring up context menus, etc.
      return;
    }
    event.preventDefault();

    const resizerElement = event.target as HTMLElement;
    if (!resizerElement) {
      return;
    }

    const leftCellContainingResizer = resizerElement.parentElement;
    if (!leftCellContainingResizer) {
      return;
    }
    let cellColumnIndex = leftCellContainingResizer.dataset.colIndex;
    let cellRowIndex = leftCellContainingResizer.dataset.rowIndex;

    /* If the user is dragging via the filler row we use slightly different
     * attributes to figure out the columns involved in the resize.
     */
    if (leftCellContainingResizer.hasAttribute('data-filler-row-column-index')) {
      cellColumnIndex = leftCellContainingResizer.dataset.fillerRowColumnIndex;
      cellRowIndex = String(this.rows.length);
    }

    if (!cellColumnIndex || !cellRowIndex) {
      return;
    }
    const positionOfLeftCell: CellPosition =
        [globalThis.parseInt(cellColumnIndex, 10), globalThis.parseInt(cellRowIndex, 10)];

    /* To find the cell to the right we can't just go +1 as it might be hidden,
     * so find the next index that is visible.
     */
    const nextVisibleColumnIndex = this.columns.findIndex((column, index) => {
      return index > positionOfLeftCell[0] && column.visible === true;
    });
    const positionOfRightCell = [nextVisibleColumnIndex, positionOfLeftCell[1]];
    const selector = `[data-col-index="${positionOfRightCell[0]}"][data-row-index="${positionOfRightCell[1]}"]`;
    const cellToRight = this.shadow.querySelector<HTMLElement>(selector);
    if (!cellToRight) {
      return;
    }

    // We query for the <col> elements as they are the elements that we put the actual width on.
    const leftCellCol =
        this.shadow.querySelector<HTMLTableColElement>(`col[data-col-column-index="${positionOfLeftCell[0]}"]`);
    const rightCellCol =
        this.shadow.querySelector<HTMLTableColElement>(`col[data-col-column-index="${positionOfRightCell[0]}"]`);
    if (!leftCellCol || !rightCellCol) {
      return;
    }

    const targetDocumentForCursorChange = (event.target as Node).ownerDocument;
    if (!targetDocumentForCursorChange) {
      return;
    }

    // We now store values that we'll make use of in the mousemouse event to calculate how much to resize the table by.
    this.currentResize = {
      leftCellCol,
      rightCellCol,
      leftCellColInitialPercentageWidth: globalThis.parseInt(leftCellCol.style.width, 10),
      rightCellColInitialPercentageWidth: globalThis.parseInt(rightCellCol.style.width, 10),
      initialLeftCellWidth: leftCellContainingResizer.clientWidth,
      initialRightCellWidth: cellToRight.clientWidth,
      initialMouseX: event.x,
      documentForCursorChange: targetDocumentForCursorChange,
      cursorToRestore: resizerElement.style.cursor,
    };

    targetDocumentForCursorChange.body.style.cursor = 'col-resize';
    resizerElement.setPointerCapture(event.pointerId);
    resizerElement.addEventListener('pointermove', this.boundOnResizePointerMove);
  }

  private onResizePointerMove(event: PointerEvent): void {
    event.preventDefault();
    if (!this.currentResize) {
      return;
    }

    const MIN_CELL_WIDTH_PERCENTAGE = 10;
    const MAX_CELL_WIDTH_PERCENTAGE =
        (this.currentResize.leftCellColInitialPercentageWidth + this.currentResize.rightCellColInitialPercentageWidth) -
        MIN_CELL_WIDTH_PERCENTAGE;
    const deltaOfMouseMove = event.x - this.currentResize.initialMouseX;
    const absoluteDelta = Math.abs(deltaOfMouseMove);
    const percentageDelta =
        (absoluteDelta / (this.currentResize.initialLeftCellWidth + this.currentResize.initialRightCellWidth)) * 100;

    let newLeftColumnPercentage;
    let newRightColumnPercentage;
    if (deltaOfMouseMove > 0) {
      /**
       * A positive delta means the user moved their mouse to the right, so we
       * want to make the right column smaller, and the left column larger.
       */
      newLeftColumnPercentage = Platform.NumberUtilities.clamp(
          this.currentResize.leftCellColInitialPercentageWidth + percentageDelta, MIN_CELL_WIDTH_PERCENTAGE,
          MAX_CELL_WIDTH_PERCENTAGE);
      newRightColumnPercentage = Platform.NumberUtilities.clamp(
          this.currentResize.rightCellColInitialPercentageWidth - percentageDelta, MIN_CELL_WIDTH_PERCENTAGE,
          MAX_CELL_WIDTH_PERCENTAGE);
    } else if (deltaOfMouseMove < 0) {
      /**
       * Negative delta means the user moved their mouse to the left, which
       * means we want to make the right column larger, and the left column
       * smaller.
       */
      newLeftColumnPercentage = Platform.NumberUtilities.clamp(
          this.currentResize.leftCellColInitialPercentageWidth - percentageDelta, MIN_CELL_WIDTH_PERCENTAGE,
          MAX_CELL_WIDTH_PERCENTAGE);
      newRightColumnPercentage = Platform.NumberUtilities.clamp(
          this.currentResize.rightCellColInitialPercentageWidth + percentageDelta, MIN_CELL_WIDTH_PERCENTAGE,
          MAX_CELL_WIDTH_PERCENTAGE);
    }

    if (!newLeftColumnPercentage || !newRightColumnPercentage) {
      // The delta was 0, so nothing to do.
      return;
    }

    // We floor one value and ceil the other so we work in whole numbers rather than vast amounts of decimal places.
    // This stops the cells from stuttering when you barely move the mouse.
    this.currentResize.leftCellCol.style.width = Math.floor(newLeftColumnPercentage) + '%';
    this.currentResize.rightCellCol.style.width = Math.ceil(newRightColumnPercentage) + '%';
  }

  private onResizePointerUp(event: PointerEvent): void {
    event.preventDefault();
    const resizer = event.target as HTMLElement;
    if (!resizer) {
      return;
    }
    resizer.releasePointerCapture(event.pointerId);
    resizer.removeEventListener('pointermove', this.boundOnResizePointerMove);
    this.cleanUpAfterResizeColumnComplete();
  }

  private renderResizeForCell(position: CellPosition): LitHtml.TemplateResult {
    /**
     * A resizer for a column is placed at the far right of the _previous column
     * cell_. So when we get called with [1, 0] that means this dragger is
     * resizing column 1, but the dragger itself is located within column 0. We
     * need the column to the left because when you resize a column you're not
     * only resizing it but also the column to its left.
     */
    const cellToLeftOfResizingCell = position[0] - 1;
    const lastVisibleColumnIndex = this.getIndexOfLastVisibleColumn();
    // If we are in the very last column, there is no column to the right to resize, so don't render a resizer.
    if (cellToLeftOfResizingCell === lastVisibleColumnIndex) {
      return LitHtml.html``;
    }

    return LitHtml.html`<span class="cell-resize-handle"
     @pointerdown=${this.boundOnResizePointerDown}
     @pointerup=${this.boundOnResizePointerUp}
    ></span>`;
  }

  private getIndexOfLastVisibleColumn(): number {
    let index = this.columns.length - 1;
    for (; index > -1; index--) {
      const col = this.columns[index];
      if (col.visible) {
        break;
      }
    }
    return index;
  }

  private toggleColumnVisibility(column: Column): void {
    const newVisibility = !column.visible;
    const newColumns = this.columns.map(col => {
      if (col === column) {
        col.visible = newVisibility;
      }
      return col;
    });
    this.data = {
      ...this.data,
      columns: newColumns,
    };
  }

  /**
   * This function is called when the user right clicks on the header row of the
   * data grid.
   */
  private onHeaderContextMenu(event: MouseEvent): void {
    if (event.button !== 2) {
      // 2 = secondary button = right click. We only show context menus if the
      // user has right clicked.
      return;
    }

    const menu = new UI.ContextMenu.ContextMenu(event);
    for (const column of this.columns) {
      if (!column.hideable) {
        continue;
      }
      /**
       * Append checkboxes for each column that is hideable; these will show
       * with checkboxes if the column is visible and allow the user to click in
       * the context menu to toggle an individual column's visibility.
       */
      menu.defaultSection().appendCheckboxItem(column.title, () => {
        this.toggleColumnVisibility(column);
      }, column.visible);
    }

    /**
     * The header row context menu also lists a sub-menu for selecting which
     * column to sort by. Because the sorting is handled by the
     * data-grid-controller, we don't control the sort here, but dispatch an
     * event so the parent can handle the sort event.
     */
    const sortableColumns = this.columns.filter(col => col.sortable === true);
    if (sortableColumns.length > 0) {
      const sortMenu = menu.defaultSection().appendSubMenuItem(Common.ls`Sort By`);
      for (const column of sortableColumns) {
        sortMenu.defaultSection().appendItem(column.title, () => {
          this.dispatchEvent(new ContextMenuColumnSortClickEvent(column));
        });
      }
    }

    menu.defaultSection().appendItem(Common.ls`Reset Columns`, () => {
      this.dispatchEvent(new Event('context-menu-header-reset-click'));
    });

    if (this.contextMenus && this.contextMenus.headerRow) {
      // Let the user append things to the menu
      this.contextMenus.headerRow(menu, this.columns);
    }
    menu.show();
  }

  private render(): void {
    const indexOfFirstVisibleColumn = this.columns.findIndex(col => col.visible);
    const anyColumnsSortable = this.columns.some(col => col.sortable === true);
    // Disabled until https://crbug.com/1079231 is fixed.
    // clang-format off
    LitHtml.render(LitHtml.html`
    <style>
      :host {
        --table-divider-color: var(--color-details-hairline);
        --toolbar-bg-color: var(--color-background-elevation-2);
        --selected-row-color: var(--color-background-elevation-1);

        height: 100%;
        display: block;
      }
      /* Ensure that vertically we don't overflow */
      .wrapping-container {
        overflow-y: scroll;
        /* Use max-height instead of height to ensure that the
           table does not use more space than necessary. */
        height: 100%;
        position: relative;
      }

      table {
        border-spacing: 0;
        width: 100%;
        height: 100%;
        /* To make sure that we properly hide overflowing text
           when horizontal space is too narrow. */
        table-layout: fixed;
      }

      tr {
        outline: none;
      }


      tbody tr {
        background-color: var(--color-background);
      }

      tbody tr.selected {
        background-color: var(--selected-row-color);
      }

      td, th {
        padding: 1px 4px;
        /* Divider between each cell, except the first one (see below) */
        border-left: 1px solid var(--table-divider-color);
        color: var(--color-text-primary);
        line-height: 18px;
        height: 18px;
        user-select: text;
        /* Ensure that text properly cuts off if horizontal space is too narrow */
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
        position: relative;
      }

      .cell-resize-handle {
        right: 0;
        top: 0;
        height: 100%;
        width: 20px;
        cursor: col-resize;
        position: absolute;
      }

      /* There is no divider before the first cell */
      td.firstVisibleColumn, th.firstVisibleColumn {
        border-left: none;
      }

      th {
        font-weight: normal;
        text-align: left;
        border-bottom: 1px solid var(--table-divider-color);
        position: sticky;
        top: 0;
        z-index: 2;
        background-color: var(--toolbar-bg-color);
      }

      .hidden {
        display: none;
      }

      .filler-row td {
        /* By making the filler row cells 100% they take up any extra height,
         * leaving the cells with content to be the regular height, and the
         * final filler row to be as high as it needs to be to fill the empty
         * space.
         */
        height: 100%;
        pointer-events: none;
      }
      .filler-row td .cell-resize-handle {
        pointer-events: all;

      }

      [aria-sort]:hover {
        cursor: pointer;
      }

      [aria-sort="descending"]::after {
        content: " ";
        border-left: 0.3em solid transparent;
        border-right: 0.3em solid transparent;
        border-top: 0.3em solid black;
        position: absolute;
        right: 0.5em;
        top: 0.6em;
      }
      [aria-sort="ascending"]::after {
        content: " ";
        border-bottom: 0.3em solid black;
        border-left: 0.3em solid transparent;
        border-right: 0.3em solid transparent;
        position: absolute;
        right: 0.5em;
        top: 0.6em;
      }
    </style>
    <div class="wrapping-container">
      <table
        aria-rowcount=${this.rows.length}
        aria-colcount=${this.columns.length}
        @keydown=${this.onTableKeyDown}
      >
        <colgroup>
          ${this.columns.map((col, colIndex) => {
            const width = calculateColumnWidthPercentageFromWeighting(this.columns, col.id);
            const style = `width: ${width}%`;
            if (!col.visible) {
              return LitHtml.nothing;
            }

            return LitHtml.html`<col style=${style} data-col-column-index=${colIndex}>`;
          })}
        </colgroup>
        <thead>
          <tr @contextmenu=${this.onHeaderContextMenu}>
            ${this.columns.map((col, columnIndex) => {
              const thClasses = LitHtml.Directives.classMap({
                hidden: !col.visible,
                firstVisibleColumn: columnIndex === indexOfFirstVisibleColumn,
              });
              const cellIsFocusableCell = anyColumnsSortable && columnIndex === this.focusableCell[0] && this.focusableCell[1] === 0;

              return LitHtml.html`<th class=${thClasses}
                data-grid-header-cell=${col.id}
                @click=${(): void => {
                  this.focusCell([columnIndex, 0]);
                  this.onColumnHeaderClick(col, columnIndex);
                }}
                title=${col.title}
                aria-sort=${LitHtml.Directives.ifDefined(this.ariaSortForHeader(col))}
                aria-colindex=${columnIndex + 1}
                data-row-index='0'
                data-col-index=${columnIndex}
                tabindex=${LitHtml.Directives.ifDefined(anyColumnsSortable ? (cellIsFocusableCell ? '0' : '-1') : undefined)}
              >${col.title}${this.renderResizeForCell([columnIndex + 1, 0])}</th>`;
            })}
          </tr>
        </thead>
        <tbody>
          ${this.rows.map((row, rowIndex): LitHtml.TemplateResult => {
            const focusableCell = this.getCurrentlyFocusableCell();
            const [,focusableCellRowIndex] = this.focusableCell;

            // Remember that row 0 is considered the header row, so the first tbody row is row 1.
            const tableRowIndex = rowIndex + 1;

            // Have to check for focusableCell existing as this runs on the
            // first render before it's ever been created.
            const rowIsSelected = focusableCell ? focusableCell === this.shadow.activeElement && tableRowIndex === focusableCellRowIndex : false;

            const rowClasses = LitHtml.Directives.classMap({
              selected: rowIsSelected,
              hidden: row.hidden === true,
            });
            return LitHtml.html`
              <tr
                aria-rowindex=${rowIndex + 1}
                class=${rowClasses}
              >${this.columns.map((col, columnIndex) => {
                const cell = getRowEntryForColumnId(row, col.id);
                const cellClasses = LitHtml.Directives.classMap({
                  hidden: !col.visible,
                  firstVisibleColumn: columnIndex === indexOfFirstVisibleColumn,
                });
                const cellIsFocusableCell = columnIndex === this.focusableCell[0] && tableRowIndex === this.focusableCell[1];
                const cellOutput = renderCellValue(cell);
                return LitHtml.html`<td
                  class=${cellClasses}
                  title=${cell.title || String(cell.value)}
                  tabindex=${cellIsFocusableCell ? '0' : '-1'}
                  aria-colindex=${columnIndex + 1}
                  data-row-index=${tableRowIndex}
                  data-col-index=${columnIndex}
                  data-grid-value-cell-for-column=${col.id}
                  @focus=${(): void => {
                    this.dispatchEvent(new BodyCellFocusedEvent(cell, row));
                  }}
                  @click=${(): void => {
                    this.focusCell([columnIndex, tableRowIndex]);
                  }}
                >${cellOutput}${this.renderResizeForCell([columnIndex + 1, tableRowIndex])}</span></td>`;
              })}
            `;
          })}
         ${this.renderFillerRow()}
        </tbody>
      </table>
    </div>
    `, this.shadow, {
      eventContext: this,
    });
    // clang-format on

    this.scrollToBottomIfRequired();
    this.hasRenderedAtLeastOnce = true;
  }
}

customElements.define('devtools-data-grid', DataGrid);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLElementTagNameMap {
    'devtools-data-grid': DataGrid;
  }
}
