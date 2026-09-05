// Examples are authored as real .py files so they can be linted and used as
// transformer fixtures in the Python test suite, then inlined at build time.
import hello from '../../examples/hello.py?raw';
import bouncingBall from '../../examples/bouncing_ball.py?raw';
import moveTheSquare from '../../examples/move_the_square.py?raw';
import catchTheBlocks from '../../examples/catch_the_blocks.py?raw';
import mousePainter from '../../examples/mouse_painter.py?raw';
import spaceGameMain from '../../examples/space_game/main.py?raw';
import spaceGameSprites from '../../examples/space_game/sprites.py?raw';

const single = (source) => ({ 'main.py': source });

export const EXAMPLES = [
  { id: 'bouncing_ball', title: 'Bouncing ball', files: single(bouncingBall) },
  { id: 'move_the_square', title: 'Move the square', files: single(moveTheSquare) },
  { id: 'catch_the_blocks', title: 'Catch the blocks', files: single(catchTheBlocks) },
  { id: 'mouse_painter', title: 'Mouse painter', files: single(mousePainter) },
  {
    id: 'space_game',
    title: 'Space game (2 files)',
    files: { 'main.py': spaceGameMain, 'sprites.py': spaceGameSprites },
  },
  { id: 'hello', title: 'Hello (text only)', files: single(hello) },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export const findExample = (id) => EXAMPLES.find((e) => e.id === id) ?? null;
