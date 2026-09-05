# A project split across two files.
#
# This file is the starting point. It imports sprites.py, which is the
# other tab above. Try opening sprites.py and changing the ship colour.

import random

import pygame

import sprites

pygame.init()
screen = pygame.display.set_mode((sprites.WIDTH, sprites.HEIGHT))
clock = pygame.time.Clock()
font = pygame.font.Font(None, 28)

ship = sprites.Ship()
stars = [
    sprites.Star(
        random.randint(0, sprites.WIDTH),
        random.randint(0, sprites.HEIGHT),
        random.choice([1, 2, 3]),
    )
    for _ in range(40)
]

running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

    ship.handle_keys(pygame.key.get_pressed())

    screen.fill((10, 10, 30))
    for star in stars:
        star.fall()
        star.draw(screen)
    ship.draw(screen)
    screen.blit(font.render("Arrow keys to move", True, (180, 180, 200)), (10, 10))

    pygame.display.flip()
    clock.tick(60)

pygame.quit()
