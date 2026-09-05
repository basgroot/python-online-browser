# Hold the mouse button and drag to paint.
# Press C to clear, and the number keys 1-4 to change colour.

import pygame

pygame.init()
screen = pygame.display.set_mode((480, 360))
clock = pygame.time.Clock()

COLOURS = [(255, 90, 90), (90, 200, 255), (150, 255, 150), (255, 230, 120)]
colour = COLOURS[0]
brush = 8

screen.fill((18, 18, 22))

running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
        elif event.type == pygame.KEYDOWN:
            if event.key == pygame.K_c:
                screen.fill((18, 18, 22))
            elif event.key == pygame.K_1:
                colour = COLOURS[0]
            elif event.key == pygame.K_2:
                colour = COLOURS[1]
            elif event.key == pygame.K_3:
                colour = COLOURS[2]
            elif event.key == pygame.K_4:
                colour = COLOURS[3]

    if pygame.mouse.get_pressed()[0]:
        pygame.draw.circle(screen, colour, pygame.mouse.get_pos(), brush)

    pygame.display.flip()
    clock.tick(60)

pygame.quit()
