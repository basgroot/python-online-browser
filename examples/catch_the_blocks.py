# A small complete game: move the paddle to catch the falling blocks.
# Shows text on screen with pygame.font, and keeps score.

import pygame
import random

pygame.init()
screen = pygame.display.set_mode((480, 360))
clock = pygame.time.Clock()
font = pygame.font.Font(None, 32)

paddle = pygame.Rect(210, 320, 70, 14)
block = pygame.Rect(random.randint(0, 450), -30, 30, 30)
fall_speed = 4
score = 0
lives = 3

running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

    keys = pygame.key.get_pressed()
    if keys[pygame.K_LEFT]:
        paddle.x -= 7
    if keys[pygame.K_RIGHT]:
        paddle.x += 7
    paddle.x = max(0, min(480 - paddle.width, paddle.x))

    block.y += fall_speed

    if block.colliderect(paddle):
        score += 1
        fall_speed += 1
        block.x = random.randint(0, 450)
        block.y = -30
    elif block.top > 360:
        lives -= 1
        block.x = random.randint(0, 450)
        block.y = -30
        if lives <= 0:
            running = False

    screen.fill((25, 25, 45))
    pygame.draw.rect(screen, (240, 240, 240), paddle)
    pygame.draw.rect(screen, (255, 120, 90), block)
    screen.blit(font.render(f"Score: {score}", True, (255, 255, 255)), (10, 10))
    screen.blit(font.render(f"Lives: {lives}", True, (255, 200, 200)), (360, 10))
    pygame.display.flip()
    clock.tick(60)

print("Game over! Final score:", score)
pygame.quit()
