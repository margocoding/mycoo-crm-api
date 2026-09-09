import 'dotenv/config'
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ValidationError } from "class-validator";
import helmet from "helmet";
import { AppModule } from "./app.module.js";


async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  app.enableCors({
    origin: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: ValidationError[]) => {
        const formattedErrors = errors.map((error) => ({
          property: error.property,
          messages: error.constraints
            ? Object.values(error.constraints)
            : [],
        }));

        return new BadRequestException({
          statusCode: 400,
          message: "Validation failed",
          errors: formattedErrors,
        });
      },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("MyCOO Auth API")
    .setDescription(
      "Авторизация, регистрация, подтверждение кода и получение JWT",
    )
    .setVersion("1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup("swagger", app, document);

  await app.listen(Number(process.env.PORT ?? 3001));
}

bootstrap();