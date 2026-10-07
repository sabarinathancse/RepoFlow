CREATE TABLE `posts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `title` varchar(200) NOT NULL,
  `body` text,
  PRIMARY KEY (`id`)
);
CREATE TABLE `comments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `post_id` int(11) NOT NULL,
  `body` text,
  `spam` tinyint(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_post` FOREIGN KEY (`post_id`) REFERENCES `posts` (`id`)
);
