# Use the arrow keys to move the square.
# pygame.key.get_pressed() tells you which keys are held down right now.

import pygame

pygame.init()
screen = pygame.display.set_mode((480, 360))
clock = pygame.time.Clock()

x, y = 220, 160
size = 40
speed = 5

running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

    keys = pygame.key.get_pressed()
    if keys[pygame.K_LEFT]:
        x -= speed
    if keys[pygame.K_RIGHT]:
        x += speed
    if keys[pygame.K_UP]:
        y -= speed
    if keys[pygame.K_DOWN]:
        y += speed

    # Keep the square on screen.
    x = max(0, min(480 - size, x))
    y = max(0, min(360 - size, y))

    screen.fill((15, 30, 25))
    pygame.draw.rect(screen, (100, 220, 140), (x, y, size, size))
    pygame.display.flip()
    clock.tick(60)

pygame.quit()
