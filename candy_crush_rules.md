# Candy Crush Rule Book

## 1. Basic Matches & Candy Creation

* **3-Match (Standard):** Align 3 candies of the same color in a straight line to clear them from the board.
* **4-Match (Horizontal):** Align 4 candies in a horizontal row to create a **Vertical Striped Candy**. Activating it clears an entire vertical column.
* **4-Match (Vertical):** Align 4 candies in a vertical column to create a **Horizontal Striped Candy**. Activating it clears an entire horizontal row.
* **L or T Match:** Align 5 candies in an "L" or "T" shape to create a **Wrapped Candy**. Activating it triggers a 3x3 grid explosion twice.
* **5-Match (Straight Line):** Align 5 candies in a single straight row or column to create a **Color Bomb**.

## 2. Special Candy Spawn Locations

The exact spawn location of a special candy depends on how the match was formed:

* **Player Swaps (Manual Moves):** When you physically drag a candy to form a match, the new special candy **always spawns on the specific tile you dragged your candy into**.
* **Cascades (Automatic / Falling Matches):** When candies fall and form a match on their own without direct user interaction, the game assigns placement using these fixed rules:
    * **Striped Candy (4-Match):** Appears in one of the middle two positions of the 4-candy line.
    * **Wrapped Candy (L or T Match):** Appears at the **exact intersection tile** where the vertical line and horizontal line cross.
    * **Color Bomb (5-Match):** Appears at the **center tile** (the 3rd candy) of the 5-candy line.

*Note on Stripe Orientation:* Dragging or matching horizontally produces a Vertical Striped Candy. Dragging or matching vertically produces a Horizontal Striped Candy.

## 3. Swapping Behaviors & Activation

When you swap a special candy (like a Striped Candy) with a regular different-colored candy, the outcome depends on whether a match is formed:

* **No Match Formed (Invalid Move):** If swapping the two candies does not create a line of 3 or more matching colors, the move fails. The candies snap back to their original positions, and the special candy **does not activate**.
* **Match Formed with the OTHER Candy's Color:** If moving the other candy creates a 3-match of *its* color, those candies clear. The special candy simply slides into its new position and **remains on the board without activating**.
* **Match Formed with the SPECIAL Candy's Color:** If moving the special candy completes a 3-in-a-row match of *its own* color, the match succeeds and the special candy **activates its effect** from its new position.
* **Swapping Special Candies Together:** Swapping any two special candies instantly activates a combo effect, completely ignoring color matching rules.

## 4. Special Candy Interactions & Board Effects

### Striped Candy Effects
* **Board & Jelly Interaction:** Activating a Striped Candy fires a beam that destroys all candies in that row or column and removes one layer of Jelly underneath them.
* **Striped + Striped:** Clears both a full horizontal row and a full vertical column in a cross (+) pattern centered on the swap, regardless of the original stripe directions.
* **Striped + Wrapped:** Creates a giant 3-candy-wide beam that clears 3 full rows and 3 full columns in a massive cross pattern.
* **Striped + Color Bomb:** Transforms every regular candy on the board matching the Striped Candy's color into a Striped Candy, then detonates all of them simultaneously.

### Wrapped Candy Effects
* **Board & Jelly Interaction:** Explodes in a 3x3 area, drops down as board pieces fill in, and explodes a second time in a 3x3 area. It clears up to 2 layers of Jelly within its blast radius.
* **Wrapped + Wrapped:** Triggers a massive 5x5 blast area that explodes twice, destroying multi-layer obstacles and clearing huge sections of the board.
* **Wrapped + Color Bomb:** Turns every candy of the swapped Wrapped Candy's color into a Wrapped Candy and detonates them. After the explosions settle, it selects a second random color, turns all of those into Wrapped Candies, and detonates them as well.

### Color Bomb Effects
* **Standard Swap:** Swapping with a regular candy removes all candies of that color from the entire board and clears Jelly underneath each removed candy.
* **Color Bomb + Color Bomb:** Instantly clears every single candy, obstacle, and layer of Jelly currently exposed across the entire board.
