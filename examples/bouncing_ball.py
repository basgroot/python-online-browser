# A ball that bounces around the window.
# Change the numbers and press Run to see what happens.

import pygame

pygame.init()
screen = pygame.display.set_mode((480, 360))
clock = pygame.time.Clock()

x, y = 240, 180
speed_x, speed_y = 4, 3
radius = 20

running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

    x += speed_x
    y += speed_y

    if x - radius < 0 or x + radius > 480:
        speed_x = -speed_x
    if y - radius < 0 or y + radius > 360:
        speed_y = -speed_y

    screen.fill((20, 20, 40))
    pygame.draw.circle(screen, (255, 190, 60), (x, y), radius)
    pygame.display.flip()
    clock.tick(60)

pygame.quit()
