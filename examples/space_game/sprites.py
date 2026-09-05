# Helper file. main.py loads this with:  import sprites
#
# Keeping sprites in their own file makes main.py much easier to read.
# Any .py file you add here can be imported the same way.

import pygame

WIDTH = 480
HEIGHT = 360


class Ship:
    def __init__(self):
        self.rect = pygame.Rect(WIDTH // 2 - 15, HEIGHT - 40, 30, 20)
        self.speed = 6

    def handle_keys(self, keys):
        if keys[pygame.K_LEFT]:
            self.rect.x -= self.speed
        if keys[pygame.K_RIGHT]:
            self.rect.x += self.speed
        self.rect.x = max(0, min(WIDTH - self.rect.width, self.rect.x))

    def draw(self, screen):
        pygame.draw.rect(screen, (120, 220, 255), self.rect)


class Star:
    def __init__(self, x, y, speed):
        self.x = x
        self.y = y
        self.speed = speed

    def fall(self):
        self.y += self.speed
        if self.y > HEIGHT:
            self.y = 0

    def draw(self, screen):
        pygame.draw.circle(screen, (255, 255, 255), (self.x, int(self.y)), 2)
